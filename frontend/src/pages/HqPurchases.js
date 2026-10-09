// HqPurchases — HQ-side procurement page. HQ has no physical warehouse;
// each line of a purchase has a destination_slug picking which branch
// will offload the goods. Lines sit PENDING until the destination branch
// confirms with actual received qty in their Incoming Stock queue.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ItemPicker from '../components/ItemPicker';
import {
  FiRefreshCw, FiPlus, FiPackage, FiTrash2, FiEye, FiXCircle, FiPrinter, FiEdit2,
} from 'react-icons/fi';
import {
  getHqBranches, getHqPurchases, getHqPurchase, createHqPurchase, getHqSuppliers, createHqSupplier,
  cancelHqPurchaseItem, cancelHqPurchase, getProducts, getLastPurchasePrice,
  saveHqPurchaseDraft, deleteHqPurchaseDraft,} from '../services/api';
import { sortBranches } from '../utils/sortBranches';
import printHtml from '../utils/printHtml';
import Portal from '../utils/Portal';
import { useSort, SortTh } from '../components/SortableTable';
import { usePurchaseTrace, TraceSearchBox, TracePanel, TrackButton } from '../components/PurchaseTrace';

// Read-only twins of the entry form's label and input, so the View modal
// reads as the same screen rather than a different one.
const vLbl = { display: 'block', fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 };
const vBox = { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#f8fafc', fontSize: 13, color: '#0f172a', fontWeight: 600, minHeight: 19 };

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (n) => parseFloat(n || 0).toLocaleString();
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function HqPurchases() {
  const [purchases, setPurchases] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  // The draft currently open in the entry form. Same modal, same component —
  // holding it separately only so the list knows which one to write back to.
  const [editingDraft, setEditingDraft] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [toast, setToast] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  // 2026-09-09 — HQ buys for fifteen depots off one page, so "what went to
  // Livingstone" meant reading every row. Filtered here rather than on the
  // server: the list is already capped at 500 and destinations live on the
  // lines, not the header, so the server would have to join to filter.
  const [destFilter, setDestFilter] = useState('');
  // 2026-09-26 — date range, filtered on the SERVER (hqPurchases.js), unlike
  // the two filters above. The list arrives capped at the 500 newest, so a
  // date filter applied in the browser would return nothing for any range
  // older than that and read as missing data rather than as a cap.
  // Empty means no date filter, so the page opens exactly as it did before.
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate]     = useState('');
  const trace = usePurchaseTrace();
  // The search narrows the table as well as answering above it, so the list
  // and the timeline are about the same purchase.
  const traceTerm = trace.q.trim().toLowerCase();
  const matchesTrace = (p) => traceTerm.length < 2 ||
    [p.invoice_display, p.grn_number, p.purchase_number, p.supplier_name]
      .some(v => String(v || '').toLowerCase().includes(traceTerm));
  // A split purchase counts as this branch's if any one line goes there.
  const matchesDest = (p) => !destFilter ||
    String(p.dest_slugs || '').split(',').includes(destFilter);
  const visible = purchases.filter(p => matchesTrace(p) && matchesDest(p));
  // Newest first, and within a day the one just raised on top: several
  // purchases share a date every day, and the date alone cannot separate them.
  const sort = useSort(visible, 'date', 'desc', (a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || ''))
    || (b.id || 0) - (a.id || 0));

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (fromDate)     params.from   = fromDate;
      if (toDate)       params.to     = toDate;
      const r = await getHqPurchases(Object.keys(params).length ? params : undefined);
      setPurchases(r.data?.purchases || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    // 2026-09-20 — alphabetical, by the depot name people see. The list
    // arrives newest-first, so a depot had to be hunted for.
    getHqBranches().then(r => setBranches(sortBranches(r.data?.branches || []))).catch(() => {});
  }, []);
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [statusFilter, fromDate, toDate]);

  const openDetail = async (id) => {
    try {
      const r = await getHqPurchase(id);
      // 2026-09-09 — a draft has nothing to view. It has never been sent, so
      // there is no receipt, no GRN and no variance to read; the only useful
      // thing to do with it is carry on typing it. Opening it opens the form.
      if (r.data?.status === 'DRAFT') setEditingDraft(r.data);
      else setViewing(r.data);
    } catch (err) { flash(err?.response?.data?.error || 'Failed to load detail', 'error'); }
  };

  const discardDraft = async (p) => {
    if (!window.confirm(`Discard draft ${p.purchase_number}? It has not been sent to any depot, and this cannot be undone.`)) return;
    try {
      await deleteHqPurchaseDraft(p.id);
      flash(`Draft ${p.purchase_number} discarded.`, 'success');
      refresh();
    } catch (err) { flash(err?.response?.data?.error || 'Failed to discard', 'error'); }
  };

  return (
    <div className="page-content">
      {/* 2026-09-12 — phone header, as designed: the title is already in the
          top bar, so search + refresh + New on one line, then the status and
          destination filters as one sideways row. */}
      <div className="phone-only" style={{ marginBottom: 10 }}>
        <div className="nowrap-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TraceSearchBox trace={trace} style={{ ...inp, width: '100%', boxSizing: 'border-box' }} />
          </div>
          <button onClick={refresh} title="Refresh" aria-label="Refresh"
            style={{ width: 38, height: 38, flexShrink: 0, background: '#fff', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <FiRefreshCw />
          </button>
          <button onClick={() => setShowCreate(true)} title="New Purchase" aria-label="New Purchase"
            style={{ width: 38, height: 38, flexShrink: 0, background: '#13306b', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <FiPlus />
          </button>
        </div>
        <div className="cat-filter-row" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {[['', 'All'], ['DRAFT', 'Draft'], ['OPEN', 'Open'], ['COMPLETED', 'Completed']].map(([v, label]) => {
            const on = statusFilter === v;
            return (
              <button key={v || 'all'} type="button" onClick={() => setStatusFilter(v)}
                style={{ padding: '6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer',
                         border: `1px solid ${on ? '#13306b' : '#e2e6ee'}`, background: on ? '#13306b' : '#fff', color: on ? '#fff' : '#334155' }}>
                {label}
              </button>
            );
          })}
          <select value={destFilter} onChange={e => setDestFilter(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, border: `1px solid ${destFilter ? '#13306b' : '#e2e6ee'}`, background: '#fff', color: '#334155', flexShrink: 0 }}>
            <option value="">Depot ▾</option>
            {branches.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
          </select>
          {/* The date range rides the same sideways row as the other filters.
              It was desktop-only at first, which left the phone -- the way the
              depots actually use this page -- with no way to pick a range. */}
          <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0, marginLeft: 2 }}>From</span>
          <input type="date" value={fromDate} max={toDate || undefined} onChange={e => setFromDate(e.target.value)}
            style={{ padding: '5px 9px', borderRadius: 999, fontSize: 12, border: `1px solid ${fromDate ? '#13306b' : '#e2e6ee'}`, background: '#fff', color: '#334155', flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0 }}>To</span>
          <input type="date" value={toDate} min={fromDate || undefined} onChange={e => setToDate(e.target.value)}
            style={{ padding: '5px 9px', borderRadius: 999, fontSize: 12, border: `1px solid ${toDate ? '#13306b' : '#e2e6ee'}`, background: '#fff', color: '#334155', flexShrink: 0 }} />
          {(fromDate || toDate) && (
            <button type="button" onClick={() => { setFromDate(''); setToDate(''); }}
              style={{ padding: '6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0, border: '1px solid #e2e6ee', background: '#fff', color: '#334155' }}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="page-header desk-only">
        <div>
          <h1>HQ Purchases</h1>
          <p>Supplier purchases routed directly to branches · HQ holds no stock</p>
        </div>
        {/* Wraps rather than squashing: adding the date range made this row
            wider than a landscape phone, and without wrapping the selects
            collapsed to bare arrows with no readable label left on them. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* inp is width:100%, which a flex row is free to shrink to nothing
              -- that is how the two selects became bare arrows once the dates
              joined the row. Each control keeps a readable floor instead. */}
          <TraceSearchBox trace={trace} style={{ ...inp, minWidth: 200 }} />
          <select value={destFilter} onChange={e => setDestFilter(e.target.value)} style={{ ...inp, minWidth: 160 }}>
            <option value="">All destinations</option>
            {branches.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ ...inp, minWidth: 160 }}>
            <option value="">All status</option>
            <option value="DRAFT">Draft (not raised)</option>
            <option value="OPEN">Open (pending lines)</option>
            <option value="COMPLETED">Completed</option>
          </select>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>From</span>
            <input type="date" value={fromDate} max={toDate || undefined}
              onChange={e => setFromDate(e.target.value)} style={{ ...inp, minWidth: 140 }} />
            <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>To</span>
            <input type="date" value={toDate} min={fromDate || undefined}
              onChange={e => setToDate(e.target.value)} style={{ ...inp, minWidth: 140 }} />
            {(fromDate || toDate) && (
              <button onClick={() => { setFromDate(''); setToDate(''); }} title="Clear the date range"
                style={{ padding: '8px 12px', background: '#fff', color: '#334155', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontSize: 12.5 }}>
                Clear
              </button>
            )}
          </div>
          <button onClick={refresh}
            style={{ padding: '8px 14px', background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
          <button onClick={() => setShowCreate(true)}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiPlus /> New Purchase
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

      <TracePanel trace={trace} />


      <div className="phone-bare" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && purchases.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : visible.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>
            <FiPackage /> {traceTerm.length >= 2
              ? `No purchases on this page match “${trace.q.trim()}”.`
              : destFilter
                ? `No purchases for ${branches.find(b => b.slug === destFilter)?.name || destFilter}.`
                : 'No purchases yet.'}
          </p>
        ) : (
          <>
          {/* 2026-09-12 — the phone list, as designed: one card per purchase.
              The supplier's invoice number and supplier lead (what the depot
              holds on paper), then depot · date · PO. Tap opens the purchase. */}
          <div className="phone-only">
            {sort.sorted.map(p => (
              <div key={p.id} role="button" tabIndex={0} onClick={() => openDetail(p.id)}
                onKeyDown={e => { if (e.key === 'Enter') openDetail(p.id); }}
                style={{ background: '#fff', border: '1px solid #e2e6ee', borderRadius: 12, padding: '10px 12px', marginBottom: 8, cursor: 'pointer' }}>
                <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: '#0f172a', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.invoice_display ? `Inv ${p.invoice_display}` : p.purchase_number} · {p.supplier_name || '—'}
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 13, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{fmtMoney(p.total_amount)}</div>
                </div>
                <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 4 }}>
                  <div style={{ fontSize: 11.5, color: '#5b6478', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.dest_count > 1 ? `${p.dest_count} branches` : (p.dest_name || '—')} · {p.date} · <span style={{ fontFamily: 'monospace' }}>{p.purchase_number}</span>
                  </div>
                  <div style={{ flexShrink: 0 }}>{statusBadge(p.status)}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="desk-only" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  {/* 2026-09-04 — the three document numbers lead, invoice
                      first. Red Sea talks to suppliers in invoice numbers, to
                      Accounts in GRN numbers, and only to itself in PO
                      numbers, so that is the order they are needed in. */}
                  <SortTh sort={sort} k="invoice_display" style={th}>Invoice #</SortTh>
                  <SortTh sort={sort} k="grn_number" style={th}>GRN #</SortTh>
                  <SortTh sort={sort} k="purchase_number" style={th}>Purchase #</SortTh>
                  <SortTh sort={sort} k="date" style={th}>Date</SortTh>
                  <SortTh sort={sort} k="supplier_name" style={th}>Supplier</SortTh>
                  {/* 2026-09-04 — the list said who we bought from and what it
                      cost but never where it went, which is what HQ scans for. */}
                  <SortTh sort={sort} k="dest" get={p => p.dest_count > 1 ? `${p.dest_count} branches` : p.dest_name} style={th}>Destination</SortTh>
                  <SortTh sort={sort} k="total_amount" get={p => parseFloat(p.total_amount) || 0} style={{ ...th, textAlign: 'right' }}>Total</SortTh>
                  <SortTh sort={sort} k="lines" get={p => p.items_total || 0} style={th}>Lines</SortTh>
                  <SortTh sort={sort} k="status" style={th}>Status</SortTh>
                  <SortTh sort={sort} k="created_by_name" style={th}>By</SortTh>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {sort.sorted.map(p => (
                  <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    {/* Amber, not a dash, when there is no invoice number: on a
                        purchase the depot has already confirmed it means the
                        number never got recorded, which is worth noticing. */}
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, fontWeight: 700 }}>
                      {p.invoice_display || <span style={{ color: '#b45309', fontFamily: 'inherit', fontWeight: 500 }}>—</span>}
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, color: '#64748b' }}>{p.grn_number || '—'}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{p.purchase_number}</td>
                    <td style={td}>{p.date}</td>
                    <td style={td}>{p.supplier_name || '—'}</td>
                    <td style={td}>
                      {p.dest_count > 1
                        ? <span style={{ color: '#92400e', fontWeight: 600 }}>{p.dest_count} branches</span>
                        : (p.dest_name || '—')}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(p.total_amount)}</td>
                    <td style={td}>
                      {/* "0/9 (9 pending)" on a draft would be a lie twice
                          over: nothing is pending, because nothing was sent. */}
                      {p.status === 'DRAFT' ? (
                        <span style={{ color: '#64748b' }}>{fmtInt(p.items_total)} line{p.items_total === 1 ? '' : 's'}</span>
                      ) : (
                        <>
                          <span style={{ color: '#0f172a', fontWeight: 600 }}>{p.items_received}/{p.items_total}</span>
                          {p.items_pending > 0 && <span style={{ color: '#92400e', fontSize: 11, marginLeft: 6 }}>({p.items_pending} pending)</span>}
                        </>
                      )}
                    </td>
                    <td style={td}>{statusBadge(p.status)}</td>
                    <td style={td}>{p.created_by_name || '—'}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => openDetail(p.id)}
                          style={{ padding: '4px 10px', background: p.status === 'DRAFT' ? '#475569' : '#0ea5e9', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {p.status === 'DRAFT'
                            ? <><FiEdit2 size={12} /> Edit</>
                            : <><FiEye size={12} /> View</>}
                        </button>
                        {/* Discarding is only ever offered on a draft — the
                            route refuses anything else, and a purchase a depot
                            has seen is cancelled, never deleted. */}
                        {p.status === 'DRAFT' && (
                          <button onClick={() => discardDraft(p)} title="Discard this draft"
                            style={{ padding: '4px 8px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <FiTrash2 size={12} />
                          </button>
                        )}
                        {/* Invoice number first, PO number as the fallback: a
                            purchase the depot has not confirmed has no invoice
                            number yet, and still needs to be trackable. */}
                        <TrackButton trace={trace} term={p.invoice_display || p.purchase_number} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>

      {(showCreate || editingDraft) && (
        <CreatePurchaseModal
          // Keyed on the draft so reopening a different one remounts the form
          // with its values, rather than keeping the last one's state.
          key={editingDraft ? `draft-${editingDraft.id}` : 'new'}
          branches={branches}
          draft={editingDraft}
          onClose={() => { setShowCreate(false); setEditingDraft(null); }}
          onCreated={(wasDraft) => {
            setShowCreate(false); setEditingDraft(null);
            flash(wasDraft ? 'Draft saved — not sent to the depot yet.' : 'Purchase saved.', 'success');
            refresh();
          }}
          onError={(m) => flash(m, 'error')}
        />
      )}

      {viewing && (
        <DetailModal
          data={viewing}
          onClose={() => setViewing(null)}
          onChanged={async () => {
            // Re-fetch detail to reflect the cancel + refresh the list
            // so per-row counts + status tags update too.
            try {
              const r = await getHqPurchase(viewing.id);
              setViewing(r.data);
            } catch (_) { setViewing(null); }
            refresh();
          }}
          flash={flash}
        />
      )}
    </div>
  );
}

function statusBadge(s) {
  const map = {
    // 2026-09-09 — slate, not amber: a draft is not waiting on anybody, so it
    // must not read as a purchase that needs chasing.
    DRAFT:     ['#e2e8f0', '#475569', 'Draft'],
    OPEN:      ['#fef3c7', '#92400e', 'Open'],
    COMPLETED: ['#dcfce7', '#166534', 'Completed'],
    CANCELLED: ['#fee2e2', '#991b1b', 'Cancelled'],
    PENDING:   ['#fef3c7', '#92400e', 'Pending'],
    RECEIVED:  ['#dcfce7', '#166534', 'Received'],
  };
  const [bg, fg, label] = map[s] || ['#e2e8f0', '#0f172a', s];
  return <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>;
}

// 2026-09-09 — a stored line turned back into a form row.
//
// The table stores what a purchase IS: qty, base price, VAT, discount. The
// form also carries how each figure was ARRIVED AT — whether the operator
// typed the unit price or the line total, the RRP or the selling price —
// because that decides which of each pair stays editable. None of that is
// worth a column, so it is reconstructed: the stored figure is the driver,
// its partner is recomputed from it, and the form behaves exactly as it did
// when the row was first typed.
function lineFromSaved(it) {
  const qty  = parseFloat(it.dispatched_qty) || 0;
  const base = parseFloat(it.base_price) || 0;
  const vat  = parseFloat(it.vat_amount) || 0;
  const disc = parseFloat(it.discount_amount) || 0;
  const num  = (v) => (v ? String(+(+v).toFixed(4)) : '');
  return {
    product_sync_id: it.product_sync_id || '',
    product_name:    it.product_name || '',
    // The picker shows its own text, so the row reads as chosen rather than
    // as an empty box above a filled-in line.
    product_text:    it.product_name || '',
    unit:            it.unit || 'pcs',
    dispatched_qty:  qty ? String(qty) : '',
    base_price:      num(base),
    total_base:      qty && base ? String(+(base * qty).toFixed(2)) : '',
    price_mode:      'base',
    vat_amount:      vat ? String(+vat.toFixed(4)) : '',
    // Set properly once the HQ catalogue loads and the item's VAT category is
    // known — see the backfill below. Assuming an override here would freeze a
    // VAT that should still follow the qty; assuming none would quietly wipe
    // one typed off the invoice.
    vat_cat:         'A',
    vat_edited:      true,
    discount_amount: num(disc),
    base_discount:   qty && disc ? String(+(disc / qty).toFixed(4)) : '',
    discount_mode:   'total',
    cost_price:      num(it.cost_price),
    cost_locked:     true,
    hq_default_cost: base,
    // The RRP is stored on the line, so it comes back off the line — it is the
    // RRP this invoice was actually billed on, not whatever the item carries
    // today.
    rrp:             num(it.rrp),
    // S.P is NOT stored, and it is NOT derivable. Deriving it as
    // base + VAT/qty — which is what the pair does in the other direction —
    // reads cost plus tax as a selling price: COKE RGB came back at 115.7676
    // off a base of 98.94, and PET COKE ZERO got 123.7676 despite having no
    // RRP to derive anything from. Left empty here and filled from the item
    // record below, exactly as picking a product on a new purchase does.
    sp:              '',
    // 'product' so neither S.P nor RRP is re-derived from the other on open —
    // both are the figures this purchase was actually billed on.
    rrp_mode:        'product',
  };
}

// `draft` — an existing DRAFT purchase (header + items) to edit in place.
// The form is otherwise identical, which is the whole design: a draft is not
// a different kind of document, it is this one, parked.
function CreatePurchaseModal({ branches, draft, onClose, onCreated, onError }) {
  const editing = !!draft;
  const [supplierId, setSupplierId] = useState(draft?.supplier_id ? String(draft.supplier_id) : '');
  const [suppliers, setSuppliers]   = useState([]);
  const [invoice, setInvoice]   = useState(draft?.invoice_number || '');
  const [date, setDate]         = useState(draft?.date || todayISO());
  const [notes, setNotes]       = useState(draft?.notes || '');
  const [items, setItems]       = useState(() => (
    draft?.items?.length ? draft.items.map(lineFromSaved) : [newItem('')]
  ));
  // 2026-09-13 — phone only: the one item line open for editing; the rest fold
  // to a row showing product and total. The desk table ignores it.
  const [openLine, setOpenLine] = useState(0);
  // v1.9.19 — single destination for the whole PO (replaces per-line picker).
  // Kelete's procurement is one-supplier-one-branch per PO. The submit handler
  // copies this onto every line so the backend shape (per-line destination)
  // doesn't change.
  // 2026-09-20 — starts unselected. It used to default to whichever depot
  // happened to be first in the list, and an effect put that back the moment
  // anyone cleared it, so the "— branch —" placeholder could never stay
  // chosen: the form always arrived with a depot already picked, and a PO sent
  // to the wrong one is stock on the wrong truck. Submit already refuses an
  // empty destination (see onSubmit), so nothing can slip through unset.
  const [destinationSlug, setDestinationSlug] = useState(
    draft?.items?.[0]?.destination_slug || '');
  // v1.10.54 — WAC redesign push 2: FX rate for tri-currency destinations.
  // Requirement is derived, not stored: if the picked destination's
  // currency_mode contains 'USD+FRA' or 'USD+FRA+K', the operator MUST
  // pick a cost currency + rate before Save unlocks. K-only branches
  // (Mansa/Lusaka: currency_mode='K') skip this block entirely — cost
  // is native K, no conversion needed. One rate per whole PO.
  const [costCurrency, setCostCurrency] = useState(draft?.cost_currency || '');
  const [fxRate, setFxRate] = useState(draft?.fx_rate_used ? String(draft.fx_rate_used) : '');
  const destBranch = branches.find(b => b.slug === destinationSlug);
  const destIsTriCcy = (() => {
    const cm = String(destBranch?.currency_mode || 'K').toUpperCase();
    return cm === 'USD+FRA' || cm === 'USD+FRA+K';
  })();
  // Reset FX inputs whenever destination changes — a new destination
  // could flip us in/out of the tri-currency prompt.
  //
  // 2026-09-09 — but not on the first render. This effect fires on mount like
  // any other, which on a reopened draft cleared the currency and rate it was
  // saved with before the operator had touched anything.
  const destTouched = useRef(false);
  useEffect(() => {
    if (!destTouched.current) { destTouched.current = true; return; }
    setCostCurrency(''); setFxRate('');
  }, [destinationSlug]);
  const [submitting, setSubmitting] = useState(false);

  // v1.9.0 — quick-add HQ supplier (same pattern as GRN page).
  // Strict: free-text supplier entry removed; only HQ master suppliers
  // can be referenced. If the user needs a new supplier they add it
  // inline, which writes to HQ master and auto-selects.
  const [showAddSupplier, setShowAddSupplier] = useState(false);
  const [newSupName,  setNewSupName]  = useState('');
  const [newSupPhone, setNewSupPhone] = useState('');
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [addSupplierError, setAddSupplierError] = useState('');

  const [hqProducts, setHqProducts] = useState([]);
  useEffect(() => {
    getHqSuppliers()
      .then(r => setSuppliers(r.data?.suppliers || []))
      .catch(() => {});
    // v1.9.6 — pull from the regular HQ Item Details catalogue (default DB
    // `products` on keletezm.com), not the legacy master.db `hq_products`
    // table. HQ admin already manages the master list there; having two
    // sources caused the picker to show "No HQ Products yet" even though
    // the Items page was full. Filter to Active + non-deleted.
    getProducts()
      .then(r => {
        const list = Array.isArray(r.data) ? r.data : (r.data?.products || []);
        setHqProducts(list.filter(p => !p.deleted_at && (p.status || 'Active') === 'Active'));
      })
      .catch(() => {});
  }, []);

  function newItem() {
    // v1.13.36 — cost_locked defaults true. Cost is auto-fetched from
    // the HQ item on pick and locked so an operator can't fat-finger a
    // price. Click "Change" to override (e.g. a real supplier price
    // move). hq_default_cost is stashed so we can restore + show "was".
    return { product_sync_id: '', product_name: '', product_text: '', unit: 'pcs', dispatched_qty: '', base_price: '', vat_amount: '', discount_amount: '', cost_price: '', cost_locked: true, hq_default_cost: 0, rrp: '', vat_cat: 'A', vat_edited: false, price_mode: 'base', base_discount: '', discount_mode: 'total', sp: '', rrp_mode: 'product' };
  }

  // 2026-09-04 — VAT was typed off the invoice by hand. Suppliers compute it
  // on the RRP, not on what they bill us: a Varun line at base 6,352.62 shows
  // VAT 1,097.38, which is not 16% of the base (1,016.42) but 16/116 of
  // RRP x qty. Getting that right by hand, line after line, is exactly the
  // sort of arithmetic people mistype at 6am on a delivery bay.
  //
  // So it computes, on the item's own VAT category — the same rule the POS
  // applies when it sells the thing:
  //   B  VAT on MAX(what we pay, RRP x qty)   ← minimum taxable value
  //   A  16% of the base
  //   D  nothing
  //
  // 2026-09-06 — the discount comes off BEFORE the 16%. Varun bills that way
  // and their own totals prove it: (62,512.94 - 1,146.56) x 16% = 9,818.62,
  // the TOTAL VAT printed on the invoice. Charging 16% of the undiscounted
  // base made every line a little high — K13.80 on one Lays line, about K183
  // across that invoice — and every one of them had to be typed over by hand.
  //
  // It does NOT fix Zambian Breweries. They tax base + K1 per litre of excise,
  // a floor that sits above the discounted price, so the discount never gets
  // to matter and their VAT still has to be typed until that floor exists.
  const calcVat = (line) => {
    const qty  = parseFloat(line.dispatched_qty) || 0;
    const base = (parseFloat(line.base_price) || 0) * qty;
    const rrp  = (parseFloat(line.rrp) || 0) * qty;
    const cat  = String(line.vat_cat || 'A').toUpperCase();
    // Never below zero: a discount typed larger than the line would otherwise
    // hand back negative VAT.
    const net  = Math.max(0, base - (parseFloat(line.discount_amount) || 0));
    if (cat === 'D' || cat === 'E' || cat.startsWith('C')) return 0;
    if (cat === 'B' && rrp > 0) return +(Math.max(net, rrp) * 16 / 116).toFixed(4);
    return +(net * 0.16).toFixed(4);
  };

  // Recompute unless the operator has typed their own figure. A supplier's
  // rounding can differ by a ngwee and the paper is what gets paid, so their
  // number stands until they ask for it back with the reset arrow.
  const withVat = (line) => (line.vat_edited ? line : { ...line, vat_amount: String(calcVat(line)) });

  // 2026-09-09 — a reopened draft, given back its VAT categories.
  //
  // The category is a property of the ITEM, not of the purchase, so it is not
  // stored on the line — it is picked up from the catalogue when a product is
  // chosen. A draft reopens before that catalogue has loaded, which left every
  // line on category A: change a qty and the VAT would recompute at a flat 16%
  // on a Zambian Breweries case that is taxed on its RRP.
  //
  // So when the catalogue arrives, each line takes its category back. Then the
  // VAT it was saved with is compared against what that category now computes:
  // if they agree the line goes back to following the qty, and if they differ
  // the figure was typed off the invoice and is left exactly as it is. Runs
  // once, on the reopen only.
  const catsBackfilled = useRef(!draft);
  useEffect(() => {
    if (catsBackfilled.current || hqProducts.length === 0) return;
    catsBackfilled.current = true;
    setItems(arr => arr.map(line => {
      const prod = hqProducts.find(p => p.sync_id === line.product_sync_id);
      // No matching item: the category and the selling price both stay as they
      // are. A blank S.P is the honest answer — better than a number nobody
      // quoted.
      if (!prod) return line;
      const withCat = {
        ...line,
        vat_cat: prod.zra_vat_cat_cd || 'A',
        // The item's own selling price, fetched — never worked back from the
        // base price and the VAT.
        sp: prod.selling_price != null && prod.selling_price !== ''
              ? String(prod.selling_price) : '',
      };
      const saved = parseFloat(line.vat_amount) || 0;
      // A ngwee of tolerance: the stored figure is rounded to the cent, the
      // computed one to four places.
      return { ...withCat, vat_edited: Math.abs(saved - calcVat(withCat)) > 0.01 };
    }));
  // calcVat and withVat are recreated each render but read nothing that
  // changes; the guard ref is what keeps this to a single run.
  // eslint-disable-next-line
  }, [hqProducts]);

  // 2026-09-04 — Base Price and Total Base are one number seen two ways, and
  // an invoice prints both. Whichever the operator types is the one that
  // means something; the other is arithmetic and goes read-only so it cannot
  // be edited into disagreeing with its own multiplication.
  const syncPrice = (line) => {
    const qty = parseFloat(line.dispatched_qty) || 0;
    if (line.price_mode === 'total') {
      const total = parseFloat(line.total_base) || 0;
      return { ...line, base_price: qty > 0 ? String(+(total / qty).toFixed(4)) : '' };
    }
    const base = parseFloat(line.base_price) || 0;
    return { ...line, total_base: String(+(base * qty).toFixed(2)) };
  };

  // 2026-09-06 — the discount is one number seen two ways, exactly like the
  // price above it. Varun prints the line total (86.21 on 20 cases); other
  // suppliers quote per case. Whichever the operator types is the real one
  // and the other goes read-only, so the two can never be edited into
  // disagreeing with their own multiplication.
  //
  // discount_amount stays the stored field — every total, the VAT and the
  // backend all read it — so nothing downstream changes.
  // 2026-09-07 — S.P and RRP are one number seen two ways, so the operator
  // types whichever the supplier quoted.
  //
  //   VAT = RRP x 16/116           (an RRP is VAT-inclusive)
  //   S.P = base price + VAT        (what the supplier calls the selling price)
  //   so  RRP = (S.P - base) x 116/16
  //
  // Coca-Cola quote a selling price, not an RRP - it is how they explained
  // their own invoice - while Zambian Breweries quote an RRP. Same arithmetic
  // either way; this just lets each be typed from the paper in hand instead
  // of converted by someone at 6am.
  const syncRrp = (line) => {
    // 2026-09-07 — 'product' means both figures came off the item's own record
    // (zra_rrp and selling_price) and neither was typed here. Deriving one
    // from the other in that state overwrote a real recorded price with
    // arithmetic - and while Base Price was still 0 it produced nonsense: an
    // RRP of 122 showed an S.P of 16.83. Nothing is derived until the
    // operator types one of them.
    if (line.rrp_mode === 'product') return line;
    const base = parseFloat(line.base_price) || 0;
    if (line.rrp_mode === 'sp') {
      const sp = parseFloat(line.sp) || 0;
      const vatPerUnit = Math.max(0, sp - base);
      return { ...line, rrp: sp > 0 ? String(+(vatPerUnit * 116 / 16).toFixed(4)) : '' };
    }
    const rrp = parseFloat(line.rrp) || 0;
    return { ...line, sp: rrp > 0 ? String(+(base + rrp * 16 / 116).toFixed(4)) : '' };
  };

  const syncDiscount = (line) => {
    const qty = parseFloat(line.dispatched_qty) || 0;
    if (line.discount_mode === 'base') {
      const per = parseFloat(line.base_discount) || 0;
      return { ...line, discount_amount: String(+(per * qty).toFixed(2)) };
    }
    const total = parseFloat(line.discount_amount) || 0;
    return { ...line, base_discount: qty > 0 ? String(+(total / qty).toFixed(4)) : '' };
  };

  const updateItem = (i, field, value) => {
    // Qty, RRP and base all move the VAT, so the figure follows them —
    // unless the operator has pinned their own.
    // 2026-09-06 — discount moves it too now that VAT is charged on the net.
    const recalcs = field === 'dispatched_qty' || field === 'rrp'
                 || field === 'base_price' || field === 'total_base'
                 || field === 'discount_amount' || field === 'base_discount'
                 || field === 'sp';
    setItems(arr => arr.map((it, idx) => {
      if (idx !== i) return it;
      let next = { ...it, [field]: value };
      // Typing in one of the pair makes it the driver.
      if (field === 'base_price')  next.price_mode = 'base';
      if (field === 'total_base')  next.price_mode = 'total';
      if (field === 'base_discount')    next.discount_mode = 'base';
      if (field === 'discount_amount')  next.discount_mode = 'total';
      if (field === 'sp')   next.rrp_mode = 'sp';
      if (field === 'rrp')  next.rrp_mode = 'rrp';
      // syncRrp before withVat: the VAT is computed from the RRP, so the pair
      // has to settle first.
      return recalcs ? withVat(syncRrp(syncDiscount(syncPrice(next)))) : next;
    }));
  };
  const addItem = () => setItems(arr => [...arr, newItem()]);
  const removeItem = (i) => setItems(arr => arr.length > 1 ? arr.filter((_, idx) => idx !== i) : arr);

  // 2026-08-30 — the invoice's footer, computed from the lines:
  //   total base price + VAT - discount = amount due
  // Amount due is what the supplier will be paid, so it is what AP must show.
  const totals = useMemo(() => items.reduce((acc, it) => {
    const q  = parseFloat(it.dispatched_qty) || 0;
    const bp = parseFloat(it.base_price) || 0;
    acc.base     += q * bp;
    acc.vat      += parseFloat(it.vat_amount) || 0;
    acc.discount += parseFloat(it.discount_amount) || 0;
    return acc;
  }, { base: 0, vat: 0, discount: 0 }), [items]);
  const totalAmount = totals.base + totals.vat - totals.discount;

  // v1.9.0 — inline create HQ supplier; refreshes list + auto-selects.
  const handleAddSupplier = async () => {
    const name = newSupName.trim();
    if (!name) { setAddSupplierError('Name is required.'); return; }
    setAddingSupplier(true);
    setAddSupplierError('');
    try {
      const res = await createHqSupplier({ name, phone: newSupPhone.trim() || null });
      const created = res.data?.supplier || res.data || null;
      // Refetch full list so the new supplier shows in dropdown ordering
      const list = await getHqSuppliers();
      setSuppliers(list.data?.suppliers || []);
      if (created?.id) setSupplierId(String(created.id));
      setShowAddSupplier(false);
      setNewSupName(''); setNewSupPhone('');
    } catch (err) {
      setAddSupplierError(err?.response?.data?.error || 'Failed to create supplier');
    }
    setAddingSupplier(false);
  };

  // asDraft — park it. Otherwise raise it: a new purchase, or a draft
  // promoted, which are the same document by the time the server sees it.
  const submit = async (asDraft = false) => {
    // v1.9.0 — strict: every line MUST have a product_sync_id (i.e. picked
    // from HQ master). The old code allowed a free-text product_name to
    // pass through, which let garbage like "fdfdfdf" become a real
    // purchase + auto-create a branch product. Now: any line whose
    // product wasn't picked from the dropdown is rejected with a clear
    // error pointing the user to HQ Products.
    // v1.9.19 — single destination for the entire PO. Stamp it onto every
    // line so the backend (which still validates per-line destination_slug)
    // accepts the payload unchanged.
    if (!destinationSlug) return onError('Pick a destination branch for this PO.');
    // v1.10.54 — tri-currency destinations require a cost currency + FX rate.
    // K-only destinations skip this — cost is native K.
    //
    // 2026-09-09 — a draft is exempt from this and from the two checks below.
    // The point of parking one is to stop halfway: supplier not yet confirmed,
    // three lines of twenty typed, the rate still to be asked for. Every one of
    // these is enforced again the moment it is raised, which is the only moment
    // any of it commits to anything.
    if (destIsTriCcy && !asDraft) {
      if (!costCurrency) return onError('Pick the currency the supplier billed you in (destination is tri-currency).');
      if (costCurrency !== 'USD' && !(parseFloat(fxRate) > 0)) {
        return onError(`Enter the FX rate: 1 USD = ? ${costCurrency}`);
      }
    }
    const cleaned = items.map(it => ({
      product_sync_id:  (it.product_sync_id || '').trim(),
      product_name:     (it.product_name || '').trim(),
      // Carried through only so the orphan check below can name what was
      // typed. An unmatched row has no product_name, so without this a typo
      // would be silently dropped instead of explained.
      product_text:     (it.product_text || '').trim(),
      unit:             it.unit || null,
      dispatched_qty:   parseFloat(it.dispatched_qty) || 0,
      // 2026-08-30 — send the invoice's own figures. The server derives
      // cost_price from them, so nobody computes (base + VAT - discount) / qty
      // by hand and no rounding creeps in.
      base_price:       parseFloat(it.base_price) || 0,
      // Snapshot: this invoice must still show the RRP it was billed on, even
      // after the product's RRP changes.
      rrp:              parseFloat(it.rrp) || 0,
      vat_amount:       parseFloat(it.vat_amount) || 0,
      discount_amount:  parseFloat(it.discount_amount) || 0,
      destination_slug: destinationSlug,
    }));
    // A half-typed product name is an error on a real purchase and simply an
    // unfinished row on a draft — dropped, not complained about.
    const orphans = cleaned.filter(it => (it.product_name || it.product_text) && !it.product_sync_id);
    if (orphans.length > 0 && !asDraft) {
      const what = orphans[0].product_name || orphans[0].product_text;
      return onError(`"${what}" isn't in HQ Products. Pick it from the list as you type, or add it via HQ Products first.`);
    }
    const clean = cleaned.filter(it => it.product_sync_id && it.dispatched_qty > 0);
    if (clean.length === 0 && !asDraft) return onError('Add at least one valid item');
    // A discount bigger than the line is a typo, not a supplier being generous.
    const badDisc = clean.find(it => it.discount_amount > (it.dispatched_qty * it.base_price) + it.vat_amount);
    if (badDisc) {
      return onError(`Discount on "${badDisc.product_name}" is larger than the line itself. Check the invoice.`);
    }
    // v1.9.0 — supplier_id is now required (free-text supplier_name removed).
    const picked = suppliers.find(s => String(s.id) === String(supplierId));
    if (!picked && !asDraft) return onError('Pick a supplier from the dropdown, or add a new one with the + New button.');
    setSubmitting(true);
    const payload = {
      supplier_id:    picked ? picked.id : null,
      supplier_name:  picked ? picked.name : null,
      invoice_number: invoice || null,
      date,
      notes: notes || null,
      items: clean,
      status: asDraft ? 'DRAFT' : 'OPEN',
      // v1.10.54 — only send when destination is tri-currency; K-only
      // destinations omit these fields so the backend stores NULL.
      ...(destIsTriCcy && costCurrency
        ? { cost_currency: costCurrency, fx_rate_used: costCurrency === 'USD' ? 1 : parseFloat(fxRate) }
        : {}),
    };
    try {
      // Editing a draft writes back to the row it came from — same PO number,
      // same sync_id, so anything that already saw the draft follows it rather
      // than being left pointing at a number that no longer exists.
      if (editing) await saveHqPurchaseDraft(draft.id, payload);
      else         await createHqPurchase(payload);
      onCreated(asDraft);
    } catch (err) {
      onError(err?.response?.data?.error || 'Failed to save');
    }
    setSubmitting(false);
  };

  // 2026-09-13 — through <Portal>: drawn inside the page, the page's slide-in
  // transform pinned this fixed overlay to the page, so on a phone the form
  // stopped half way and the purchase list showed through under its buttons.
  return (
    <Portal>
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(1240px, 97vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>
            {editing ? 'HQ Purchase' : 'New HQ Purchase'}
            {editing && (
              <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 600, color: '#475569', background: '#e2e8f0', padding: '3px 9px', borderRadius: 10, letterSpacing: 0.4 }}>
                DRAFT · {draft.purchase_number}
              </span>
            )}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={lbl}>Supplier <span style={{ color: '#dc2626' }}>*</span></label>
              {/* v1.9.0 — strict supplier picker. Same pattern as GRN page:
                  select from HQ master, or hit "+ New" to add inline. Free-text
                  fallback removed so every purchase has a real AP linkage. */}
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  value={supplierId}
                  onChange={e => setSupplierId(e.target.value)}
                  style={{ ...inp, flex: 1 }}>
                  <option value="">— select supplier —</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.id}>{s.name}{s.balance > 0.001 ? `  (owes $${s.balance.toFixed(2)})` : ''}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => { setShowAddSupplier(v => !v); setAddSupplierError(''); }}
                  title="Add new HQ supplier"
                  style={{ padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: showAddSupplier ? '#dcfce7' : '#f9fafb', color: showAddSupplier ? '#16a34a' : '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  + New
                </button>
              </div>

              {showAddSupplier && (
                <div style={{ marginTop: 8, padding: '12px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#15803d', marginBottom: 8 }}>Quick-add HQ Supplier</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      value={newSupName} onChange={e => setNewSupName(e.target.value)}
                      placeholder="Supplier name *"
                      style={{ flex: 2, minWidth: 120, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                    />
                    <input
                      value={newSupPhone} onChange={e => setNewSupPhone(e.target.value)}
                      placeholder="Phone (optional)"
                      style={{ flex: 1, minWidth: 100, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                    />
                    <button
                      type="button" onClick={handleAddSupplier} disabled={addingSupplier}
                      style={{ padding: '7px 14px', background: addingSupplier ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: addingSupplier ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                      {addingSupplier ? '…' : 'Create'}
                    </button>
                    <button
                      type="button" onClick={() => { setShowAddSupplier(false); setNewSupName(''); setNewSupPhone(''); setAddSupplierError(''); }}
                      style={{ padding: '7px 10px', background: '#fff', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                      Cancel
                    </button>
                  </div>
                  {addSupplierError && <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{addSupplierError}</div>}
                </div>
              )}
            </div>
            {/* v1.9.19 — Purchase # field removed from the form (it's
                auto-generated server-side and shown on the PO list / detail).
                Single PO-level Destination replaces the per-line picker. */}
            <div>
              <label style={lbl}>Destination Branch <span style={{ color: '#dc2626' }}>*</span></label>
              <select value={destinationSlug} onChange={e => setDestinationSlug(e.target.value)} style={inp}>
                <option value="">— branch —</option>
                {branches.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Date</label><input type="date" value={date} onChange={e => setDate(e.target.value)} style={inp} /></div>
            {/* 2026-09-04 — the supplier's invoice number, captured when the PO
                is raised. `invoice` state and the invoice_number payload field
                have both existed since v1.9; only this input was missing, so
                the column was NULL on every PO ever raised and the number only
                entered the system when a depot confirmed receipt — three steps
                later. Suppliers are dealt with by invoice number, so it has to
                exist from the start or nothing can be traced by it.

                Optional: an invoice sometimes arrives after the goods, and the
                branch still stamps supplier_invoice_number at confirm. */}
            <div>
              <label style={lbl}>Supplier Invoice #</label>
              <input value={invoice} onChange={e => setInvoice(e.target.value)}
                     placeholder="if known now" style={inp} />
            </div>
          </div>

          {/* v1.10.54 — WAC redesign push 2: FX rate row.
              Only rendered when destination is a tri-currency branch
              (Kassumbalesa). One rate applies to every line on this PO. */}
          {destIsTriCcy && (
            <div style={{ marginBottom: 14, padding: '10px 12px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#78350f', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                FX Rate (required — destination is tri-currency)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={lbl}>Cost billed in <span style={{ color: '#dc2626' }}>*</span></label>
                  <select value={costCurrency} onChange={e => setCostCurrency(e.target.value)} style={inp}>
                    <option value="">— currency —</option>
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
                    placeholder={costCurrency === 'USD' ? 'n/a — USD already' : costCurrency === 'K' ? 'e.g. 25' : costCurrency === 'FRA' ? 'e.g. 2250' : ''}
                    style={{ ...inp, background: (!costCurrency || costCurrency === 'USD') ? '#f9fafb' : '#fff' }} />
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: '#78350f', marginTop: 6, fontStyle: 'italic' }}>
                One rate locks the whole PO. USD-billed POs skip the rate — cost is used as-is.
              </div>
            </div>
          )}
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Notes</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Truck #, driver, PO ref, etc." style={inp} />
          </div>

          <label style={{ ...lbl, fontSize: 13 }}>Items (all delivered to the destination branch chosen above)</label>
          <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            {/* 2026-09-13 — purchase-lines: on a phone each line is a labelled
                card laid out by index.css from these same cells, so the price,
                VAT and discount logic below exists once. Labels come from the
                headers (Layout fills data-label). */}
            <table className="purchase-lines" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={{ ...thS, minWidth: 210 }}>Product</th>
                  <th style={{ ...thS, width: 62 }}>Unit</th>
                  <th style={{ ...thS, textAlign: 'right', width: 80 }}>Qty</th>
                  {/* 2026-08-30 — the invoice's own columns, in the order a
                      supplier prints them, so entering one is copying not
                      calculating. */}
                  <th style={{ ...thS, textAlign: 'right', width: 90 }}>RRP</th>
                  <th style={{ ...thS, textAlign: 'right', width: 95 }}>S.P</th>
                  <th style={{ ...thS, textAlign: 'right', width: 100 }}>Base Price</th>
                  <th style={{ ...thS, textAlign: 'right', width: 110 }}>Total Base</th>
                  <th style={{ ...thS, textAlign: 'right', width: 110 }}>VAT</th>
                  <th style={{ ...thS, textAlign: 'right', width: 100 }}>Base Discount</th>
                  <th style={{ ...thS, textAlign: 'right', width: 110 }}>Total Discount</th>
                  {/* 2026-09-07 — the two figures a supplier's invoice foots
                      to. Net is base less discount, which is what Coca-Cola
                      print as "Net Amount Payable"; add the VAT and you have
                      their "Gross Amount Payable". "Line Total" said neither,
                      so it was renamed to the one it is. */}
                  {/* The trailing spaces keep the card label "Total VAT Exclusive"
                      rather than "Total VATExclusive" — <br> adds no text. */}
                  <th style={{ ...thS, textAlign: 'right', width: 115 }}>{'Total VAT '}<br />Exclusive</th>
                  <th style={{ ...thS, textAlign: 'right', width: 115 }}>{'VAT '}<br />Inclusive</th>
                  <th style={{ ...thS, width: 34 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const baseTotal = (parseFloat(it.dispatched_qty) || 0) * (parseFloat(it.base_price) || 0);
                  return (
                    <tr key={i} className={openLine === i ? 'pl-open' : 'pl-folded'} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={tdS}>
                        {/* v1.9.0 — strict picker only. Free-text input removed:
                            it let arbitrary strings like "fdfdfdf" become a
                            purchase, auto-creating ghost branch products. If the
                            HQ master is empty, show a clear empty-state instead
                            of a typeable input. */}
                        {hqProducts.length > 0 ? (
                          <ItemPicker
                            products={hqProducts}
                            text={it.product_text || ''}
                            selected={!!it.product_sync_id}
                            style={cellInp}
                            onPick={(picked, label) => {
                              // v1.13.36 — cost auto-locks to the HQ item's
                              // cost_price on pick. hq_default_cost tracks the
                              // "official" price so overrides can be
                              // visualised + reverted.
                              const hqCost = parseFloat(picked.cost_price ?? picked.default_cost_price ?? 0) || 0;
                              // What we actually paid this supplier last time.
                              // products.cost_price is the LANDED cost — base
                              // plus VAT less discount — so prefilling from it
                              // put a number in the field that appears on no
                              // invoice. Async: the line fills immediately with
                              // what we have and corrects itself a moment later.
                              getLastPurchasePrice(picked.sync_id, supplierId || undefined)
                                .then(r => {
                                  const last = parseFloat(r.data?.base_price) || 0;
                                  // 2026-09-11 — the discount per unit on that
                                  // same last invoice, remembered the way the
                                  // base price is. Filled per unit, so the line
                                  // total follows the qty typed.
                                  const lastDisc = parseFloat(r.data?.base_discount) || 0;
                                  if (!(last > 0) && !(lastDisc > 0)) return;
                                  setItems(arr => arr.map((row, idx) => {
                                    if (idx !== i || row.product_sync_id !== picked.sync_id) return row;
                                    let next = row;
                                    // Never overwrite something already typed.
                                    const typedBase = parseFloat(row.base_price) > 0 && row.price_mode === 'base'
                                        && parseFloat(row.base_price) !== hqCost;
                                    if (last > 0 && !typedBase) {
                                      next = {
                                        ...next,
                                        base_price: String(last),
                                        last_price_from: r.data?.from || null,
                                        last_price_date: r.data?.date || null,
                                        rrp: row.rrp || (r.data?.rrp ? String(r.data.rrp) : ''),
                                      };
                                    }
                                    const typedDisc = parseFloat(row.discount_amount) > 0 || parseFloat(row.base_discount) > 0;
                                    if (lastDisc > 0 && !typedDisc) {
                                      next = { ...next, base_discount: String(+lastDisc.toFixed(4)), discount_mode: 'base' };
                                    }
                                    if (next === row) return row;
                                    return withVat(syncRrp(syncDiscount(syncPrice(next))));
                                  }));
                                })
                                .catch(() => {});
                              setItems(arr => arr.map((row, idx) => idx === i ? withVat(syncRrp({
                                ...row,
                                product_sync_id: picked.sync_id,
                                product_name:    picked.name,
                                product_text:    label,
                                unit:            picked.default_unit || picked.unit || 'pcs',
                                // The RRP and category we already hold for this
                                // item, so the VAT fills itself. Editable — the
                                // invoice in hand wins over our record.
                                rrp:             picked.zra_rrp != null && picked.zra_rrp !== '' ? String(picked.zra_rrp) : '',
                                // The item's own selling price, not a figure
                                // worked back from the RRP.
                                sp:              picked.selling_price != null && picked.selling_price !== '' ? String(picked.selling_price) : '',
                                vat_cat:         picked.zra_vat_cat_cd || 'A',
                                vat_edited:      false,
                                base_price:      String(hqCost),
                                hq_default_cost: hqCost,
                                cost_locked:     true,
                                rrp_mode:        'product',
                              })) : row));
                            }}
                            onClear={() => {
                              // Explicit "choose again". Replaces the old
                              // behaviour where typing over a chosen item
                              // silently unlinked it.
                              setItems(arr => arr.map((row, idx) => idx === i ? {
                                ...row,
                                product_sync_id: '',
                                product_name:    '',
                                product_text:    '',
                                unit:            'pcs',
                                rrp:             '',
                                vat_cat:         'A',
                                vat_edited:      false,
                                base_price:      '',
                                vat_amount:      '',
                                discount_amount: '',
                                base_discount:   '',
                                discount_mode:   'total',
                                sp:              '',
                                rrp_mode:        'product',
                                hq_default_cost: 0,
                                cost_locked:     true,
                              } : row));
                            }}
                            onText={(text) => {
                              // Typing away from a chosen item drops the link.
                              // The row cannot be saved unresolved, which is
                              // the v1.9.0 guarantee: typing FINDS an item, it
                              // never invents one.
                              setItems(arr => arr.map((row, idx) => idx === i ? {
                                ...row,
                                product_sync_id: '',
                                product_name:    '',
                                product_text:    text,
                                base_price:      '',
                                vat_amount:      '',
                                discount_amount: '',
                                base_discount:   '',
                                discount_mode:   'total',
                                sp:              '',
                                rrp_mode:        'product',
                                hq_default_cost: 0,
                                cost_locked:     true,
                              } : row));
                            }}
                          />
                        ) : (
                          <div style={{ ...cellInp, color: '#dc2626', fontSize: 11, padding: '6px 8px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4 }}>
                            No items yet — add them under <strong>Store &rarr; Item Details</strong> first.
                          </div>
                        )}
                      </td>
                      {/* 2026-08-30 — unit comes from the item, and is not
                          typeable. It used to be free text, so a unit the
                          product does not have could be typed onto a purchase
                          line. Red Sea carries ONE unit per product, so there
                          is nothing to pick between — it is shown, not asked. */}
                      <td style={tdS}>
                        <input type="text" value={it.unit || ''} readOnly tabIndex={-1}
                               title="Comes from the item"
                               style={{ ...cellInp, background: '#f8fafc', color: '#6b7280', cursor: 'default' }} />
                      </td>
                      <td style={tdS}><input type="number" min="0" step="any" value={it.dispatched_qty} onChange={e => updateItem(i, 'dispatched_qty', e.target.value)} style={{ ...cellInp, textAlign: 'right' }} /></td>
                      {/* 2026-09-04 — the RRP the supplier charges VAT on. Filled
                          from the item, editable because the invoice in hand
                          beats our record. Tinted when it came from us, so a
                          blank is visibly a blank rather than a zero. */}
                      <td style={tdS}>
                        <input type="number" min="0" step="any" value={it.rrp}
                          onChange={e => updateItem(i, 'rrp', e.target.value)}
                          placeholder="—"
                          title={it.vat_cat === 'B' ? 'VAT is charged on this, not on the base' : 'Only category B items charge VAT on the RRP'}
                          readOnly={it.rrp_mode === 'sp'}
                          onFocus={() => it.rrp_mode === 'sp' && updateItem(i, 'rrp_mode', 'rrp')}
                          style={{ ...cellInp, textAlign: 'right',
                                   background: it.rrp_mode === 'sp' ? '#f8fafc' : (it.rrp ? '#f0f9ff' : '#fff'),
                                   color: it.rrp_mode === 'sp' ? '#64748b' : (it.vat_cat === 'B' ? '#0f172a' : '#94a3b8'),
                                   cursor: it.rrp_mode === 'sp' ? 'pointer' : 'text' }} />
                      </td>
                      {/* The supplier's selling price — base + VAT. Coca-Cola
                          quote this rather than an RRP, so either can be typed
                          and the other derives. */}
                      <td style={tdS}>
                        <input type="number" min="0" step="any"
                          value={it.rrp_mode === 'rrp' ? (it.sp ? Number(it.sp).toFixed(2) : '') : (it.sp ?? '')}
                          onChange={e => updateItem(i, 'sp', e.target.value)}
                          readOnly={it.rrp_mode === 'rrp'}
                          onFocus={() => it.rrp_mode === 'rrp' && updateItem(i, 'rrp_mode', 'sp')}
                          title={it.rrp_mode === 'rrp'
                            ? 'Base price + VAT — click to type this instead of the RRP'
                            : it.rrp_mode === 'product'
                              ? "This item's selling price. Type over it if the supplier quoted a different one."
                              : 'The selling price the supplier quoted'}
                          placeholder="—"
                          style={{ ...cellInp, textAlign: 'right',
                                   background: it.rrp_mode === 'rrp' ? '#f8fafc' : '#fff',
                                   color: it.rrp_mode === 'rrp' ? '#64748b' : '#0f172a',
                                   cursor: it.rrp_mode === 'rrp' ? 'pointer' : 'text' }} />
                      </td>
                      {/* 2026-09-04 — the Change lock is gone. It came in at
                          v1.13.36 to stop typos on a fixed-price catalogue,
                          which made sense while HQ's cost WAS the price. On an
                          invoice screen the base price is different every
                          delivery, so the lock guarded the normal case and put
                          a click in front of every line. The GRN is where a
                          purchase gets checked. */}
                      <td style={tdS}>
                        <input type="number" min="0" step="any" value={it.base_price}
                          onChange={e => updateItem(i, 'base_price', e.target.value)}
                          readOnly={it.price_mode === 'total'}
                          onFocus={() => it.price_mode === 'total' && updateItem(i, 'price_mode', 'base')}
                          title={it.price_mode === 'total' ? 'Derived from Total Base — click to type this instead' : ''}
                          placeholder="0.00"
                          style={{ ...cellInp, textAlign: 'right',
                                   background: it.price_mode === 'total' ? '#f8fafc' : '#fff',
                                   color: it.price_mode === 'total' ? '#64748b' : '#0f172a',
                                   cursor: it.price_mode === 'total' ? 'pointer' : 'text' }} />
                        {it.hq_default_cost > 0 && Math.abs((parseFloat(it.base_price) || 0) - it.hq_default_cost) > 0.005 && (
                          <div style={{ fontSize: 10, color: '#92400e', textAlign: 'right', marginTop: 2 }}>
                            was {fmtMoney(it.hq_default_cost)}
                            <button type="button"
                              onClick={() => setItems(arr => arr.map((r, idx) => idx === i
                                ? withVat(syncRrp(syncPrice({ ...r, base_price: String(r.hq_default_cost || 0), price_mode: 'base' }))) : r))}
                              style={{ padding: 0, marginLeft: 4, background: 'none', border: 'none', color: '#0ea5e9', cursor: 'pointer', fontSize: 10, fontWeight: 600, textDecoration: 'underline' }}>
                              revert
                            </button>
                          </div>
                        )}
                      </td>
                      {/* The other half of the same number. Type here instead
                          and Base Price becomes the derived one — an invoice
                          prints both and either is a fair thing to copy. */}
                      <td style={tdS}>
                        <input type="number" min="0" step="any"
                          value={it.price_mode === 'total' ? (it.total_base ?? '') : (baseTotal ? baseTotal.toFixed(2) : '')}
                          onChange={e => updateItem(i, 'total_base', e.target.value)}
                          readOnly={it.price_mode === 'base'}
                          onFocus={() => it.price_mode === 'base' && updateItem(i, 'price_mode', 'total')}
                          title={it.price_mode === 'base' ? 'Qty x Base Price — click to type this instead' : ''}
                          placeholder="0.00"
                          style={{ ...cellInp, textAlign: 'right', fontWeight: 700,
                                   background: it.price_mode === 'base' ? '#f8fafc' : '#fff',
                                   color: it.price_mode === 'base' ? '#64748b' : '#0f172a',
                                   cursor: it.price_mode === 'base' ? 'pointer' : 'text' }} />
                      </td>
                      {/* Computed, never locked. Typing here pins the line to
                          the operator's figure — a supplier's rounding differs
                          by a ngwee sometimes and the paper is what gets paid.
                          The arrow puts it back to the calculation. */}
                      <td style={tdS}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'flex-end' }}>
                          <input type="number" min="0" step="any" value={it.vat_amount}
                            onChange={e => setItems(arr => arr.map((r, idx) => idx === i
                              ? { ...r, vat_amount: e.target.value, vat_edited: true } : r))}
                            placeholder="0.00"
                            title={it.vat_edited ? 'Your figure — not recalculated' : 'Calculated from the RRP'}
                            style={{ ...cellInp, textAlign: 'right',
                                     background: it.vat_edited ? '#fffbeb' : '#f8fafc',
                                     borderColor: it.vat_edited ? '#f59e0b' : undefined }} />
                          {it.vat_edited && (
                            <button type="button" title="Back to the calculated figure"
                              onClick={() => setItems(arr => arr.map((r, idx) => idx === i
                                ? withVat({ ...r, vat_edited: false }) : r))}
                              style={{ padding: '0 3px', background: 'none', border: 'none', color: '#0ea5e9', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>
                              ↻
                            </button>
                          )}
                        </div>
                      </td>
                      {/* Discount per unit — the same pair as Base Price and
                          Total Base. Type here and Total Discount derives. */}
                      <td style={tdS}>
                        <input type="number" min="0" step="any"
                          value={it.discount_mode === 'base'
                            ? (it.base_discount ?? '')
                            : (parseFloat(it.discount_amount) > 0 && parseFloat(it.dispatched_qty) > 0
                                ? (parseFloat(it.discount_amount) / parseFloat(it.dispatched_qty)).toFixed(4)
                                : '')}
                          onChange={e => updateItem(i, 'base_discount', e.target.value)}
                          readOnly={it.discount_mode === 'total'}
                          onFocus={() => it.discount_mode === 'total' && updateItem(i, 'discount_mode', 'base')}
                          title={it.discount_mode === 'total' ? 'Derived from Total Discount — click to type this instead' : ''}
                          placeholder="0.00"
                          style={{ ...cellInp, textAlign: 'right',
                                   background: it.discount_mode === 'total' ? '#f8fafc' : '#fff',
                                   color: it.discount_mode === 'total' ? '#64748b' : '#0f172a',
                                   cursor: it.discount_mode === 'total' ? 'pointer' : 'text' }} />
                      </td>
                      <td style={tdS}>
                        <input type="number" min="0" step="any"
                          value={it.discount_mode === 'base'
                            ? (parseFloat(it.discount_amount) > 0 ? parseFloat(it.discount_amount).toFixed(2) : '')
                            : (it.discount_amount ?? '')}
                          onChange={e => updateItem(i, 'discount_amount', e.target.value)}
                          readOnly={it.discount_mode === 'base'}
                          onFocus={() => it.discount_mode === 'base' && updateItem(i, 'discount_mode', 'total')}
                          title={it.discount_mode === 'base' ? 'Qty x Base Discount — click to type this instead' : ''}
                          placeholder="0.00"
                          style={{ ...cellInp, textAlign: 'right', fontWeight: 700,
                                   background: it.discount_mode === 'base' ? '#f8fafc' : '#fff',
                                   color: it.discount_mode === 'base' ? '#64748b' : '#0f172a',
                                   cursor: it.discount_mode === 'base' ? 'pointer' : 'text' }} />
                      </td>
                      <td style={{ ...tdS, textAlign: 'right', color: '#475569' }}>
                        {fmtMoney(baseTotal - (parseFloat(it.discount_amount) || 0))}
                      </td>
                      <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, color: '#0f172a' }}>
                        {fmtMoney(baseTotal + (parseFloat(it.vat_amount) || 0) - (parseFloat(it.discount_amount) || 0))}
                      </td>
                      <td style={tdS}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          {/* Phone only: fold a finished line to one row, open another. */}
                          <button type="button" className="phone-only" onClick={() => setOpenLine(openLine === i ? -1 : i)}
                            style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid #cbd5e1', background: openLine === i ? '#13306b' : '#fff', color: openLine === i ? '#fff' : '#13306b', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                            {openLine === i ? 'Done' : 'Edit'}
                          </button>
                          <button onClick={() => removeItem(i)} disabled={items.length === 1}
                            style={{ background: 'none', border: 'none', color: items.length === 1 ? '#cbd5e1' : '#dc2626', cursor: items.length === 1 ? 'not-allowed' : 'pointer', padding: 2 }}>
                            <FiTrash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button onClick={() => { addItem(); setOpenLine(items.length); }}
            style={{ marginTop: 8, padding: '6px 12px', background: '#f1f5f9', color: '#0f172a', border: '1px dashed #cbd5e1', borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <FiPlus size={12} /> Add line
          </button>

          {/* Mirrors the bottom of a supplier invoice, so the entered purchase
              can be ticked off against the paper line by line. */}
          <div style={{ marginTop: 14, padding: '12px 14px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#0c4a6e', marginBottom: 4 }}>
              <span>Total Base Price</span><span>{fmtMoney(totals.base)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#b91c1c', marginBottom: 4 }}>
              <span>Less discount</span><span>− {fmtMoney(totals.discount)}</span>
            </div>
            {/* Base less discount — the figure a supplier calls "Net Amount
                Payable". Having it on screen means the invoice can be checked
                before VAT enters the picture, which is where the arguments
                usually are. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#334155', marginBottom: 4, fontWeight: 600 }}>
              <span>Total VAT Exclusive</span><span>{fmtMoney(totals.base - totals.discount)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#0c4a6e', marginBottom: 6 }}>
              <span>VAT</span><span>{fmtMoney(totals.vat)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #bae6fd', paddingTop: 8 }}>
              <strong style={{ color: '#0c4a6e' }}>Amount Due</strong>
              <strong style={{ color: '#0c4a6e', fontSize: 17 }}>{fmtMoney(totalAmount)}</strong>
            </div>
          </div>
        </div>

        <div style={{ padding: 14, borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '10px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          {/* 2026-09-09 — the same form, two ways out of it. Draft is
              deliberately the quieter button: parking is the safe act and
              raising is the one that reaches fifteen depots. */}
          <button onClick={() => submit(true)} disabled={submitting}
            style={{ padding: '10px 18px', background: '#fff', color: '#475569',
                     border: '1px solid #cbd5e1', borderRadius: 6,
                     cursor: submitting ? 'default' : 'pointer', fontWeight: 600 }}>
            {editing ? 'Save Draft' : 'Save as Draft'}
          </button>
          <button onClick={() => submit(false)} disabled={submitting}
            style={{ padding: '10px 22px',
                     background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Saving…' : editing ? 'Raise Purchase' : 'Save Purchase'}
            {/* On a phone the pinned button carries the amount due. */}
            {!submitting && <span className="phone-only" style={{ fontSize: 11, fontWeight: 600, opacity: 0.9, fontFamily: 'monospace' }}>{fmtMoney(totalAmount)}</span>}
          </button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

function DetailModal({ data, onClose, onChanged, flash }) {
  const items = data.items || [];
  // Whole-purchase cancel is only safe while NO line has been received
  // (a received line moved real stock — v1 doesn't reverse those).
  const anyReceived = items.some(it => it.status === 'RECEIVED');
  const anyPending  = items.some(it => it.status === 'PENDING');
  const headerCancellable = !anyReceived && data.status !== 'CANCELLED' && data.status !== 'COMPLETED';

  const doLineCancel = async (it) => {
    if (!window.confirm(`Cancel line "${it.product_name}" (${parseFloat(it.dispatched_qty).toFixed(2)} ${it.unit || ''} → ${it.destination_name || it.destination_slug})?`)) return;
    try {
      await cancelHqPurchaseItem(it.id);
      flash?.('Line cancelled.', 'success');
      onChanged?.();
    } catch (err) {
      flash?.(err?.response?.data?.error || 'Cancel failed', 'error');
    }
  };

  const doWholeCancel = async () => {
    if (!window.confirm(`Cancel entire purchase ${data.purchase_number}? All pending lines will be cancelled.`)) return;
    try {
      await cancelHqPurchase(data.id);
      flash?.('Purchase cancelled.', 'success');
      onChanged?.();
    } catch (err) {
      flash?.(err?.response?.data?.error || 'Cancel failed', 'error');
    }
  };

  // 2026-09-13 — through <Portal>, like the entry form, so on a phone it covers
  // the screen instead of being pinned inside the transformed page.
  return (
    <Portal>
    <div style={overlay}>
      {/* 2026-09-09 — the same width as the entry form. At 900px the twelve
          columns it now mirrors were cut off mid-table. */}
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(1240px, 97vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0 }}>{data.purchase_number}</h3>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              {data.supplier_name || 'Supplier —'} · Invoice {data.supplier_invoice_number || data.invoice_number || '—'}
              {/* Both numbers, when they disagree. The depot counting the
                  delivery reads the paper in its hand; HQ typed what the
                  order was raised against. A mismatch is worth seeing, not
                  worth hiding behind a fallback. */}
              {data.supplier_invoice_number && data.invoice_number
                && data.supplier_invoice_number !== data.invoice_number && (
                <span style={{ color: '#b45309' }}> (raised as {data.invoice_number})</span>
              )}
              {' · '}{data.date}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={() => printHtml(renderPurchaseDocket(data))}
              style={{ padding: '6px 12px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <FiPrinter size={12} /> Print Docket
            </button>
            {headerCancellable && (
              <button onClick={doWholeCancel}
                style={{ padding: '6px 12px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <FiXCircle size={12} /> Cancel Purchase
              </button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
          </div>
        </div>
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {/* 2026-09-09 — the same header the purchase was typed into, in the
              same order and the same places, so a saved purchase can be read
              straight against the paper without translating field names. The
              four status pills moved to one line underneath: they belong to
              the saved record, not to the invoice. */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={vLbl}>Supplier</label>
              <div style={vBox}>{data.supplier_name || '—'}</div>
            </div>
            <div>
              <label style={vLbl}>Destination Branch</label>
              <div style={vBox}>
                {items[0]?.destination_name || items[0]?.destination_slug || '—'}
                {new Set(items.map(i => i.destination_slug)).size > 1 && (
                  <span style={{ color: '#92400e', fontWeight: 700 }}> · split</span>
                )}
              </div>
            </div>
            <div>
              <label style={vLbl}>Date</label>
              <div style={vBox}>{data.date || '—'}</div>
            </div>
            <div>
              <label style={vLbl}>Supplier Invoice #</label>
              <div style={vBox}>
                {data.supplier_invoice_number || data.invoice_number || '—'}
                {data.supplier_invoice_number && data.invoice_number
                  && data.supplier_invoice_number !== data.invoice_number && (
                  <span style={{ color: '#b45309', fontWeight: 500 }}> (raised as {data.invoice_number})</span>
                )}
              </div>
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={vLbl}>Notes</label>
            <div style={{ ...vBox, color: data.notes ? '#0f172a' : '#cbd5e1' }}>{data.notes || '—'}</div>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <Pill label="Status" value={statusBadge(data.status)} />
            <Pill label="Lines" value={`${fmtInt(items.length)}`} />
            <Pill label="By" value={data.created_by_name || '—'} />
          </div>
          {/* Twelve columns now — scroll the table rather than the page, so a
              narrow screen never pushes the modal sideways. */}
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 980 }}>
            <thead style={{ background: '#f8fafc' }}>
              <tr>
                <th style={th}>Product</th>
                <th style={th}>Unit</th>
                <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                {/* 2026-09-04 — the same figures as New HQ Purchase, in the
                    same order. Cost alone is the landed unit cost, which is
                    right for stock and profit but appears nowhere on the
                    supplier's invoice — so there was no way to check a saved
                    purchase against the paper it came from. */}
                <th style={{ ...th, textAlign: 'right' }}>RRP</th>
                <th style={{ ...th, textAlign: 'right' }}>S.P</th>
                <th style={{ ...th, textAlign: 'right' }}>Base Price</th>
                <th style={{ ...th, textAlign: 'right' }}>Total Base</th>
                <th style={{ ...th, textAlign: 'right' }}>VAT</th>
                <th style={{ ...th, textAlign: 'right' }}>Base Discount</th>
                <th style={{ ...th, textAlign: 'right' }}>Total Discount</th>
                <th style={{ ...th, textAlign: 'right' }}>Total VAT Excl</th>
                <th style={{ ...th, textAlign: 'right' }}>VAT Inclusive</th>
                {/* Everything above is the entry form, column for column.
                    These three only exist once a depot has counted the
                    delivery, so they could not appear on it. */}
                <th style={{ ...th, textAlign: 'right' }}>Received</th>
                <th style={th}>Status</th>
                <th style={th}>Notes</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => {
                const variance = it.status === 'RECEIVED' && it.received_qty !== it.dispatched_qty;
                return (
                  <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9', background: variance ? '#fffbeb' : it.status === 'CANCELLED' ? '#fafafa' : '#fff', opacity: it.status === 'CANCELLED' ? 0.6 : 1 }}>
                    <td style={td}>{it.product_name}</td>
                    <td style={{ ...td, color: '#64748b' }}>{it.unit || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{parseFloat(it.dispatched_qty).toFixed(2)}</td>
                    <td style={{ ...td, textAlign: 'right', color: parseFloat(it.rrp) > 0 ? '#0f172a' : '#cbd5e1' }}>
                      {parseFloat(it.rrp) > 0 ? fmtMoney(it.rrp) : '—'}
                    </td>
                    {/* S.P = base + VAT per unit — the figure the supplier
                        quotes. Derived, because it was never stored. */}
                    <td style={{ ...td, textAlign: 'right', color: '#475569' }}>
                      {parseFloat(it.dispatched_qty) > 0
                        ? fmtMoney((parseFloat(it.base_price) || 0)
                                   + (parseFloat(it.vat_amount) || 0) / parseFloat(it.dispatched_qty))
                        : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(it.base_price)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>
                      {fmtMoney((parseFloat(it.dispatched_qty) || 0) * (parseFloat(it.base_price) || 0))}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(it.vat_amount)}</td>
                    <td style={{ ...td, textAlign: 'right', color: parseFloat(it.discount_amount) > 0 ? '#b91c1c' : '#94a3b8' }}>
                      {parseFloat(it.dispatched_qty) > 0 && parseFloat(it.discount_amount) > 0
                        ? fmtMoney(parseFloat(it.discount_amount) / parseFloat(it.dispatched_qty))
                        : fmtMoney(0)}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: parseFloat(it.discount_amount) > 0 ? '#b91c1c' : '#94a3b8' }}>
                      {parseFloat(it.discount_amount) > 0 ? `−${fmtMoney(it.discount_amount)}` : fmtMoney(0)}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: '#475569' }}>
                      {fmtMoney((parseFloat(it.dispatched_qty) || 0) * (parseFloat(it.base_price) || 0)
                                - (parseFloat(it.discount_amount) || 0))}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>
                      {fmtMoney(it.line_total != null
                        ? it.line_total
                        : (parseFloat(it.dispatched_qty) || 0) * (parseFloat(it.base_price) || 0)
                          + (parseFloat(it.vat_amount) || 0) - (parseFloat(it.discount_amount) || 0))}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: variance ? '#b91c1c' : '#0f172a', fontWeight: variance ? 700 : 400 }}>
                      {it.received_qty == null ? '—' : parseFloat(it.received_qty).toFixed(2)}
                    </td>
                    <td style={td}>{statusBadge(it.status)}</td>
                    <td style={{ ...td, color: '#64748b' }}>{it.variance_notes || ''}</td>
                    <td style={td}>
                      {it.status === 'PENDING' && (
                        <button onClick={() => doLineCancel(it)} title="Cancel this line"
                          style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 2 }}>
                          <FiTrash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {/* The entry form's footer, on the same figures. It is what gets
              checked against the supplier's own totals. */}
          {(() => {
            const t = items.reduce((acc, it) => {
              const q = parseFloat(it.dispatched_qty) || 0;
              acc.base += q * (parseFloat(it.base_price) || 0);
              acc.vat  += parseFloat(it.vat_amount) || 0;
              acc.disc += parseFloat(it.discount_amount) || 0;
              return acc;
            }, { base: 0, vat: 0, disc: 0 });
            const row = (label, value, style) => (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4, ...style }}>
                <span>{label}</span><span>{value}</span>
              </div>
            );
            return (
              <div style={{ marginTop: 14, marginLeft: 'auto', maxWidth: 380, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 10, padding: '12px 16px' }}>
                {row('Total Base Price', fmtMoney(t.base), { color: '#0c4a6e' })}
                {row('Less discount', `− ${fmtMoney(t.disc)}`, { color: '#b91c1c' })}
                {row('Total VAT Exclusive', fmtMoney(t.base - t.disc), { color: '#334155', fontWeight: 600 })}
                {row('VAT', fmtMoney(t.vat), { color: '#0c4a6e' })}
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #bae6fd', paddingTop: 8, marginTop: 4 }}>
                  <strong style={{ color: '#0c4a6e' }}>Amount Due</strong>
                  <strong style={{ color: '#0c4a6e', fontSize: 17 }}>{fmtMoney(t.base + t.vat - t.disc)}</strong>
                </div>
              </div>
            );
          })()}
          {anyPending && (
            <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 10 }}>
              <FiTrash2 size={10} style={{ verticalAlign: 'middle' }} /> Cancel only removes pending lines; received lines stay in branch stock.
            </p>
          )}
        </div>
      </div>
    </div>
    </Portal>
  );
}

function Pill({ label, value }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #f1f5f9', borderRadius: 8, padding: '6px 12px' }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}

// A4-style dispatch docket — handed to the supplier driver so they know
// which branch each line drops at. Items grouped by destination_slug
// with per-destination subtotals. Routed through the same printHtml
// util (iframe + print dialog on desktop, PDF on mobile).
function renderPurchaseDocket(p) {
  const fmt = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Bucket lines by destination so the driver can hand-off cleanly.
  const groups = {};
  for (const it of (p.items || [])) {
    const key = it.destination_slug;
    if (!groups[key]) groups[key] = { name: it.destination_name || key, items: [], subtotal: 0 };
    groups[key].items.push(it);
    groups[key].subtotal += (parseFloat(it.line_total) || 0);
  }
  const groupHtml = Object.entries(groups).map(([slug, g]) => `
    <div style="margin-top:14px;">
      <div style="background:#f1f5f9;padding:6px 10px;border-radius:4px;font-size:13px;font-weight:700;">
        → ${escapeHtml(g.name)} <span style="color:#64748b;font-weight:500;">(${escapeHtml(slug)})</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;">
        <thead><tr style="background:#fff;border-bottom:1px solid #e2e8f0;">
          <th style="text-align:left;padding:6px;">Product</th>
          <th style="text-align:left;padding:6px;width:60px;">Unit</th>
          <th style="text-align:right;padding:6px;width:80px;">Qty</th>
          <th style="text-align:right;padding:6px;width:90px;">Cost</th>
          <th style="text-align:right;padding:6px;width:100px;">VAT Inclusive</th>
        </tr></thead>
        <tbody>
          ${g.items.map(it => `<tr style="border-bottom:1px dashed #e2e8f0;">
            <td style="padding:6px;">${escapeHtml(it.product_name)}</td>
            <td style="padding:6px;">${escapeHtml(it.unit || '')}</td>
            <td style="text-align:right;padding:6px;">${parseFloat(it.dispatched_qty).toFixed(2)}</td>
            <td style="text-align:right;padding:6px;">${fmt(it.cost_price)}</td>
            <td style="text-align:right;padding:6px;font-weight:700;">${fmt(it.line_total)}</td>
          </tr>`).join('')}
          <tr style="background:#f8fafc;">
            <td colspan="4" style="padding:6px;text-align:right;font-weight:700;">Subtotal — ${escapeHtml(g.name)}</td>
            <td style="padding:6px;text-align:right;font-weight:800;">${fmt(g.subtotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escapeHtml(p.purchase_number || 'purchase')}-docket</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { margin: 0; font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a; }
  h1 { margin: 0 0 4px 0; font-size: 20px; }
  .muted { color: #64748b; font-size: 12px; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; margin: 14px 0 6px 0; font-size: 13px; }
  .meta-grid div span:first-child { color: #64748b; display: inline-block; min-width: 100px; }
  .total-box { margin-top: 18px; padding: 12px 14px; background: #0f172a; color: #fff; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; font-size: 16px; }
  .signoff { margin-top: 28px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; font-size: 11px; color: #64748b; }
  .signoff > div { border-top: 1px solid #94a3b8; padding-top: 4px; }
</style>
</head>
<body>
  <h1>HQ Purchase Docket</h1>
  <div class="muted">Kelete · ${escapeHtml(p.purchase_number || '')}</div>
  <div class="meta-grid">
    <div><span>Supplier:</span><strong>${escapeHtml(p.supplier_name || '—')}</strong></div>
    <div><span>Invoice #:</span><strong>${escapeHtml(p.supplier_invoice_number || p.invoice_number || '—')}</strong></div>
    <div><span>Date:</span><strong>${escapeHtml(p.date || '')}</strong></div>
    <div><span>Logged by:</span><strong>${escapeHtml(p.created_by_name || '—')}</strong></div>
  </div>
  ${p.notes ? `<div style="margin-top:8px;padding:8px 10px;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;font-size:12px;">${escapeHtml(p.notes)}</div>` : ''}
  ${groupHtml || '<p class="muted">No items.</p>'}
  <div class="total-box">
    <span>PURCHASE TOTAL</span>
    <span>${fmt(p.total_amount)}</span>
  </div>
  <div class="signoff">
    <div>Loaded by (HQ)</div>
    <div>Driver / collector</div>
    <div>Received by (branch)</div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const cellInp = { width: '100%', padding: '5px 7px', border: '1px solid #e2e8f0', borderRadius: 4, fontSize: 12, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const thS = { padding: '6px 8px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase' };
const tdS = { padding: '4px 6px', color: '#0f172a' };
