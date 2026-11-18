// HqGrnArchive — v1.9.14
// HQ-wide list of every CONFIRMED branch GRN, served from the
// master.db snapshot table. Full GRN doc (line items + credit notes)
// stays at the branch and is fetched on demand via "See Details".
//
// Filters: branch, supplier, from/to date. Roll-up footer shows item
// subtotal, CN total, and final payable across the filtered set so
// HQ can spot per-supplier or per-period AP movement at a glance.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiEye, FiInbox, FiX, FiPaperclip, FiUser, FiClock, FiFileText, FiSlash,
  FiPackage, FiSearch, FiChevronDown, FiChevronUp } from 'react-icons/fi';
import { getHqGrnArchive, getHqGrn, getHqGrnDetail, getHqBranches, getHqSuppliers, voidHqGrn,
  getHqGrnProductReport, getHqGrnProductBreakdown } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useSort, SortTh } from '../components/SortableTable';
import { usePurchaseTrace, TraceSearchBox, TracePanel, TrackButton } from '../components/PurchaseTrace';

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthAgoISO = () => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
};

export default function HqGrnArchive() {
  const [rows, setRows]       = useState([]);
  // 2026-09-04 - the same purchase trace as HQ Purchases. A GRN number is
  // often the only reference to hand here, and the question asked of it is
  // the same one: what still has to happen before this is paid.
  const trace = usePurchaseTrace();
  // The search narrows the table as well as answering above it. Showing the
  // timeline for one GRN while 24 unrelated rows sat underneath meant the
  // list and the answer were about different things.
  const traceTerm = trace.q.trim().toLowerCase();
  const visible = traceTerm.length < 2 ? rows : rows.filter(g =>
    [g.invoice_number, g.grn_number, g.po_number, g.supplier_name]
      .some(v => String(v || '').toLowerCase().includes(traceTerm)));
  // Default order matches what the server returns: newest confirmation first.
  const sort = useSort(visible, 'confirmed_at', 'desc');
  const [totals, setTotals]   = useState({ count: 0, subtotal: 0, cn: 0, payable: 0 });
  const [branches, setBranches] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [branch, setBranch]   = useState('all');
  const [supplier, setSupplier] = useState('all');
  const [from, setFrom]       = useState(monthAgoISO());
  const [to, setTo]           = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [viewing, setViewing] = useState(null); // { grn, items, loading } | null
  // 2026-09-17 — Void GRN, HQ Administrator only (the server checks too).
  const { user } = useAuth();
  const canVoid = user?.role === 'Administrator';
  const [voiding, setVoiding] = useState(false);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await getHqGrnArchive({ branch, supplier, from, to });
      setRows(res.data?.grns || []);
      setTotals(res.data?.totals || { count: 0, subtotal: 0, cn: 0, payable: 0 });
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load.');
    }
    setLoading(false);
  };

  useEffect(() => {
    getHqBranches().then(r => setBranches(r.data?.branches || [])).catch(() => {});
    getHqSuppliers().then(r => setSuppliers(r.data?.suppliers || [])).catch(() => {});
  }, []);

  // Re-query whenever filters change.
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [branch, supplier, from, to]);

  const shown = traceTerm.length < 2
    ? { ...totals, searching: false }
    : {
        searching: true,
        count:    visible.length,
        subtotal: visible.reduce((a, g) => a + (parseFloat(g.items_subtotal) || 0), 0),
        cn:       visible.reduce((a, g) => a + (parseFloat(g.cn_total)       || 0), 0),
        payable:  visible.reduce((a, g) => a + (parseFloat(g.final_payable)  || 0), 0),
      };

  const seeDetails = async (g) => {
    setViewing({ grn: g, items: [], cnRows: [], loading: true, source: g.source, row: g });
    try {
      // v1.10.3 — HQ-generated GRNs live at master.db → hq_grns. Legacy
      // ones live at the branch DB. Route to the correct detail endpoint.
      const r = g.source === 'hq'
        ? await getHqGrnDetail(g.grn_sync_id)
        : await getHqGrn(g.branch_slug, g.grn_sync_id);
      setViewing({
        grn:   r.data?.grn   || g,
        items: r.data?.items || [],
        cnRows: r.data?.credit_notes || [],
        loading: false,
        source: g.source,
        row: g,
      });
    } catch (err) {
      setViewing({ grn: g, items: [], cnRows: [], loading: false, source: g.source, row: g, error: err?.response?.data?.error || 'Failed to load details.' });
    }
  };

  // 2026-09-17 — Void GRN. The server refuses (and changes nothing) when AP
  // has approved or paid it, a later credit note exists, or the stock is gone.
  const handleVoid = async (row) => {
    const syncId = row.grn_sync_id;
    const reason = window.prompt(
      `Void GRN ${row.grn_number}?\n\n` +
      'This reverses it everywhere: the depot stock, HQ AP and the supplier balance, ' +
      'the credit notes made with it, cancels the purchase, and sends a Return to ZRA.\n\n' +
      'Reason (required):'
    );
    if (reason === null) return;
    if (reason.trim().length < 3) { alert('Please give a reason of at least 3 characters.'); return; }
    if (!window.confirm(`Void GRN ${row.grn_number} now? This cannot be undone.`)) return;
    setVoiding(true);
    try {
      const r = await voidHqGrn(syncId, reason.trim());
      const d = r.data || {};
      const z = d.zra;
      const zraLine = !z ? ''
        : z.skipped ? `ZRA: nothing sent (${z.reason}).`
        : z.ok === false ? `ZRA: the Return FAILED (${z.error || 'see ZRA Smart Invoice log'}). Tell support.`
        : 'ZRA: Return sent.';
      alert(
        `GRN ${d.grn_number || row.grn_number} voided.\n` +
        (d.purchase_cancelled ? 'Purchase cancelled.\n' : '') +
        ((d.credit_notes_voided || []).length ? `Credit notes voided: ${d.credit_notes_voided.join(', ')}\n` : '') +
        zraLine +
        ((d.warnings || []).length ? `\n\n${d.warnings.join('\n')}` : '')
      );
      setViewing(null);
      load();
    } catch (err) {
      const d = err?.response?.data || {};
      const lines = (d.shortages || []).map(s => `• ${s.product_name}: needs ${s.needed}, only ${s.in_stock} in stock`);
      alert((d.error || 'Void failed.') + (lines.length ? `\n\n${lines.join('\n')}` : ''));
    }
    setVoiding(false);
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ GRN Archive</h1>
          <p>Every confirmed Goods Received Note across all branches</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <TraceSearchBox trace={trace} style={inp} />
          <button onClick={load}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
        </div>
      </div>

      {/* Above the filters deliberately: the trace answers a question about one
          purchase, and is not narrowed by the branch/date filters below. */}
      <TracePanel trace={trace} />

      {/* Filters */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, padding: 14, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 14 }}>
        <div>
          <label style={lbl}>Branch</label>
          <select value={branch} onChange={e => setBranch(e.target.value)} style={inp}>
            <option value="all">All branches</option>
            {branches.map(b => <option key={b.slug} value={b.slug}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Supplier</label>
          <select value={supplier} onChange={e => setSupplier(e.target.value)} style={inp}>
            <option value="all">All suppliers</option>
            {suppliers.map(s => <option key={s.id} value={s.sync_id || s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        </div>
        <div>
          <label style={lbl}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        </div>
      </div>

      {/* Roll-up cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
        {/* Recomputed from the rows actually shown while a search is active.
            Leaving the server's filter totals up there would have said 24
            GRNs over a table showing one. */}
        <Card label={shown.searching ? 'GRNs (matching)' : 'GRNs'} value={shown.count.toLocaleString()} color="#0ea5e9" />
        <Card label="Items Subtotal" value={fmtMoney(shown.subtotal)}     color="#0f172a" />
        <Card label="Credit Notes"   value={`−${fmtMoney(shown.cn)}`}     color="#dc2626" />
        <Card label="Final Payable"  value={fmtMoney(shown.payable)}      color="#16a34a" big />
      </div>

      {/* Takes the page's own branch and date filters rather than carrying a
          second set: two date ranges on one screen, each driving a different
          table, is a reliable way to read one and believe the other. */}
      <ProductReceivedPanel from={from} to={to} branch={branch} branches={branches} />

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && rows.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : visible.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>
            <FiInbox /> {traceTerm.length >= 2
              ? `No GRNs on this page match “${trace.q.trim()}”. It may be outside the branch or date filters below.`
              : 'No GRNs match those filters.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <SortTh sort={sort} k="date" style={th}>Date</SortTh>
                  {/* 2026-09-04 — invoice number ahead of the GRN number, the
                      same order as HQ Purchases. It is the number the supplier
                      quotes, so it is the one being scanned for. */}
                  <SortTh sort={sort} k="invoice_number" style={th}>Invoice #</SortTh>
                  <SortTh sort={sort} k="grn_number" style={th}>GRN #</SortTh>
                  <SortTh sort={sort} k="po_number" style={th}>From PO</SortTh>
                  <SortTh sort={sort} k="branch" get={g => g.branch_name || g.branch_slug} style={th}>Branch</SortTh>
                  <SortTh sort={sort} k="supplier_name" style={th}>Supplier</SortTh>
                  <SortTh sort={sort} k="items_count" get={g => parseFloat(g.items_count) || 0} style={{ ...th, textAlign: 'right' }}>Items</SortTh>
                  <SortTh sort={sort} k="items_subtotal" get={g => parseFloat(g.items_subtotal) || 0} style={{ ...th, textAlign: 'right' }}>Subtotal</SortTh>
                  <SortTh sort={sort} k="cn_total" get={g => parseFloat(g.cn_total) || 0} style={{ ...th, textAlign: 'right' }}>CN</SortTh>
                  <SortTh sort={sort} k="final_payable" get={g => parseFloat(g.final_payable) || 0} style={{ ...th, textAlign: 'right' }}>Payable</SortTh>
                  <SortTh sort={sort} k="payment_status" get={g => g.payment_status || 'NOT_PAID'} style={th}>Payment</SortTh>
                  <SortTh sort={sort} k="confirmed_at" style={th}>Confirmed</SortTh>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {sort.sorted.map(g => (
                  <tr key={g.grn_sync_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>{g.date}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, fontWeight: 700 }}>{g.invoice_number || '—'}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{g.grn_number}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, color: '#64748b' }}>{g.po_number || '—'}</td>
                    <td style={td}>{g.branch_name || g.branch_slug}</td>
                    <td style={td}>{g.supplier_name || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{g.items_count}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(g.items_subtotal)}</td>
                    <td style={{ ...td, textAlign: 'right', color: g.cn_total > 0 ? '#dc2626' : '#94a3b8' }}>{g.cn_total > 0 ? `−${fmtMoney(g.cn_total)}` : '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmtMoney(g.final_payable)}</td>
                    {/* 2026-08-30 — payment state. The Archive showed nothing
                        about whether a GRN had been paid, so there was no way
                        to tell a settled delivery from an unpaid one without
                        opening AP Approvals. Partially Paid also carries the
                        balance, since that is the number anyone chasing it
                        actually needs. */}
                    <td style={td}>
                      {g.voided_at ? (
                        <span title={`Voided${g.voided_by_name ? ` by ${g.voided_by_name}` : ''}${g.void_reason ? ` — ${g.void_reason}` : ''}`}
                          style={{ padding: '3px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                                   background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
                          Voided
                        </span>
                      ) : (() => {
                        const st = g.payment_status || 'NOT_PAID';
                        const meta = st === 'PAID'
                          ? { label: 'Paid',           bg: '#dcfce7', color: '#166534', border: '#86efac' }
                          : st === 'PARTIAL'
                          ? { label: 'Partially Paid', bg: '#fef3c7', color: '#b45309', border: '#fcd34d' }
                          : { label: 'Not Paid',       bg: '#f1f5f9', color: '#64748b', border: '#e2e8f0' };
                        return (
                          <>
                            <span style={{ padding: '3px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                                           background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
                              {meta.label}
                            </span>
                            {st === 'PARTIAL' && (
                              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>
                                {fmtMoney(g.remaining_amount)} left
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td style={{ ...td, fontSize: 11, color: '#64748b' }}>
                      {g.confirmed_at ? new Date(g.confirmed_at).toLocaleString() : '—'}
                      {g.confirmed_by_name ? <div style={{ color: '#94a3b8' }}>{g.confirmed_by_name}</div> : null}
                    </td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => seeDetails(g)}
                          style={{ padding: '5px 12px', background: '#fff', color: '#0ea5e9', border: '1px solid #bae6fd', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <FiEye size={12} /> See Details
                        </button>
                        {/* Track by the invoice number where we hold one — it is
                            the reference the supplier will quote back. The GRN
                            number is the fallback, and always exists here. */}
                        <TrackButton trace={trace} term={g.invoice_number || g.grn_number} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewing && (
        <DetailsModal state={viewing} onClose={() => setViewing(null)}
          canVoid={canVoid} voiding={voiding} onVoid={handleVoid} />
      )}
    </div>
  );
}

function Card({ label, value, color, big }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: big ? 24 : 20, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function ProvenanceField({ label, value, extra, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', fontFamily: mono ? 'monospace' : 'inherit' }}>{value}</div>
      {extra}
    </div>
  );
}

// v1.10.3 — cross-subdomain URL for branch-hosted invoice photos. The
// upload landed in TENANTS_DIR/<slug>/uploads/, so we point the browser at
// <slug>.<apex>/uploads/<path>.
function branchUploadUrl(branchSlug, path) {
  if (!path || !branchSlug) return null;
  const currentHost = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  if (currentHost.startsWith(`${branchSlug}.`)) return `/uploads/${path}`;
  const parts = currentHost.split('.');
  const apex = parts.length > 2 ? parts.slice(1).join('.') : currentHost;
  const proto = (typeof window !== 'undefined' && window.location.protocol) || 'https:';
  return `${proto}//${branchSlug}.${apex}/uploads/${path}`;
}

// v1.10.4 — full provenance modal. Header shows GRN #; a Provenance card
// lays out PO, supplier, invoice # + attachment, branch confirmer,
// HQ generator, and timestamps. Line items + credit notes + totals follow.
function DetailsModal({ state, onClose, canVoid, voiding, onVoid }) {
  const { grn, items, cnRows, loading, error, source, row } = state;
  const voidedAt = grn.voided_at || row?.voided_at;
  const voidReason = grn.void_reason || row?.void_reason;
  const voidedBy = grn.voided_by_name || row?.voided_by_name;
  // Only GRNs generated at HQ can be voided; legacy branch-made ones can't.
  const showVoid = canVoid && source === 'hq' && !voidedAt && !loading;
  const itemsSubtotal = items.reduce((s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0), 0);
  const invoiceNumber = grn.invoice_number || grn.supplier_invoice_number;
  const invoiceUrl    = branchUploadUrl(grn.branch_slug, grn.invoice_attachment);
  const confirmedByBranch     = grn.confirmed_by_branch_name;
  const confirmedAtBranch     = grn.confirmed_at_branch;
  const generatedByHq         = grn.generated_by_hq_name || grn.confirmed_by_name;
  const generatedAt           = grn.generated_at        || grn.confirmed_at;
  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 12, width: 'min(960px, 95vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>GRN {grn.grn_number || grn.grn_sync_id}</h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
              Branch: <strong>{grn.branch_name || grn.branch_slug}</strong>
              {grn.date && <> · {grn.date}</>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {voidedAt && (
            <div style={{ marginBottom: 14, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 13 }}>
              <strong>VOIDED</strong>{voidedBy ? ` by ${voidedBy}` : ''} · {new Date(voidedAt).toLocaleString()}
              {voidReason && <div style={{ marginTop: 3 }}>Reason: {voidReason}</div>}
            </div>
          )}
          {loading ? (
            <p style={{ color: '#64748b' }}>Loading…</p>
          ) : error ? (
            <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8 }}>
              {error}
              <div style={{ fontSize: 11, marginTop: 6, color: '#7f1d1d' }}>The branch may be offline. Snapshot totals are still visible on the list.</div>
            </div>
          ) : (
            <>
              {/* Provenance */}
              <div style={{ padding: 14, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <ProvenanceField label="From PO" value={grn.po_number || '—'} mono />
                <ProvenanceField label="Supplier" value={grn.supplier_name || '—'} />
                <ProvenanceField
                  label="Supplier Invoice #"
                  value={invoiceNumber || '—'}
                  extra={invoiceUrl && (
                    <a href={invoiceUrl} target="_blank" rel="noopener noreferrer"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4, color: '#1d4ed8', fontSize: 11, fontWeight: 600, textDecoration: 'none' }}>
                      <FiPaperclip size={11} /> View attachment
                    </a>
                  )}
                />
                <ProvenanceField
                  label={<><FiUser size={11} style={{ verticalAlign: 'middle' }}/> Confirmed at branch</>}
                  value={confirmedByBranch || '—'}
                  extra={confirmedAtBranch && (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      <FiClock size={10} style={{ verticalAlign: 'middle' }}/> {new Date(confirmedAtBranch).toLocaleString()}
                    </div>
                  )}
                />
                <ProvenanceField
                  label={<><FiFileText size={11} style={{ verticalAlign: 'middle' }}/> Generated at HQ</>}
                  value={generatedByHq || '—'}
                  extra={generatedAt && (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      <FiClock size={10} style={{ verticalAlign: 'middle' }}/> {new Date(generatedAt).toLocaleString()}
                    </div>
                  )}
                />
                <ProvenanceField label="Branch" value={grn.branch_name || grn.branch_slug} />
                {grn.notes && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <ProvenanceField label="Notes" value={grn.notes} />
                  </div>
                )}
              </div>

              <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#374151' }}>Line Items</h4>
              {items.length === 0 ? (
                <p style={{ color: '#9ca3af', fontStyle: 'italic' }}>No line items.</p>
              ) : (
                <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead style={{ background: '#f8fafc' }}>
                    <tr>
                      <th style={th}>Product</th>
                      <th style={th}>Unit</th>
                      <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                      {/* 2026-08-30 — the archive is the permanent record of a
                          delivery, so it carries the supplier's own figures and
                          not just the cost the system worked out from them. */}
                      <th style={{ ...th, textAlign: 'right' }}>Base Price</th>
                      <th style={{ ...th, textAlign: 'right' }}>Total Base</th>
                      <th style={{ ...th, textAlign: 'right' }}>VAT</th>
                      <th style={{ ...th, textAlign: 'right' }}>Discount</th>
                      <th style={{ ...th, textAlign: 'right', color: '#7c3aed' }}>Cost</th>
                      <th style={{ ...th, textAlign: 'right' }}>Line $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => (
                      <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={td}><strong>{it.product_name || `#${it.product_id}`}</strong>{it.product_code && <span style={{ color: '#94a3b8', fontSize: 11 }}> ({it.product_code})</span>}</td>
                        <td style={td}>{it.unit || it.product_base_unit}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{parseFloat(it.quantity || 0).toLocaleString()}</td>
                        <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{fmtMoney(it.base_price)}</td>
                        <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{fmtMoney(parseFloat(it.quantity || 0) * parseFloat(it.base_price || 0))}</td>
                        <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{fmtMoney(it.vat_amount)}</td>
                        <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>{fmtMoney(it.discount_amount)}</td>
                        <td style={{ ...td, textAlign: 'right', color: '#7c3aed', fontWeight: 700, background: '#faf5ff' }}>{fmtMoney(it.unit_price)}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(parseFloat(it.quantity || 0) * parseFloat(it.unit_price || 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 700 }}>
                      <td colSpan={9} style={td}>Items subtotal</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(itemsSubtotal || grn.items_subtotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}

              {cnRows && cnRows.length > 0 && (
                <>
                  <h4 style={{ margin: '18px 0 8px', fontSize: 13, color: '#374151' }}>Credit Notes</h4>
                  {/* 2026-08-30 — the archive listed only type, notes and a
                      total, so a K66,621.54 credit could not be traced to what
                      was actually returned. Each note now shows its lines and
                      the same Total / VAT / Grand Total footer the supplier
                      printed. */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {cnRows.map(c => {
                      const cnItems = Array.isArray(c.items) ? c.items : [];
                      const lineSum = cnItems.reduce((a, x) => a + (parseFloat(x.total_price) || 0), 0);
                      return (
                        <div key={c.id} style={{ border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', overflow: 'hidden' }}>
                          <div style={{ padding: '9px 12px', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                            <span>
                              <strong style={{ color: '#7f1d1d' }}>{c.reason}</strong>
                              {c.credit_note_number && <span style={{ fontSize: 11, color: '#991b1b' }}> · {c.credit_note_number}</span>}
                              {c.notes && <span style={{ fontSize: 11, color: '#991b1b' }}> · {c.notes}</span>}
                            </span>
                            <strong style={{ color: '#dc2626' }}>−{fmtMoney(c.amount)}</strong>
                          </div>
                          {cnItems.length > 0 && (
                            <div style={{ overflowX: 'auto', background: '#fff' }}>
                              <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead style={{ background: '#fff7f7' }}>
                                  <tr>
                                    <th style={th}>Product</th>
                                    <th style={th}>Unit</th>
                                    <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                                    <th style={{ ...th, textAlign: 'right' }}>Unit Value</th>
                                    <th style={{ ...th, textAlign: 'right' }}>Discount</th>
                                    <th style={{ ...th, textAlign: 'right' }}>Total</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {cnItems.map((it, idx) => (
                                    <tr key={idx} style={{ borderTop: '1px solid #fee2e2' }}>
                                      <td style={td}>{it.product_name || '—'}</td>
                                      <td style={td}>{it.unit || '—'}</td>
                                      <td style={{ ...td, textAlign: 'right' }}>{parseFloat(it.quantity || 0).toLocaleString()}</td>
                                      <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(it.unit_value)}</td>
                                      <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(it.discount)}</td>
                                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(it.total_price)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr style={{ background: '#fff7f7', borderTop: '1px solid #fecaca' }}>
                                    <td colSpan={5} style={{ ...td, textAlign: 'right', color: '#7f1d1d' }}>Total</td>
                                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#7f1d1d' }}>{fmtMoney(lineSum)}</td>
                                  </tr>
                                  <tr style={{ background: '#fff7f7' }}>
                                    <td colSpan={5} style={{ ...td, textAlign: 'right', color: '#7f1d1d' }}>VAT Amount</td>
                                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#7f1d1d' }}>{fmtMoney(c.vat_amount)}</td>
                                  </tr>
                                  <tr style={{ background: '#fef2f2', borderTop: '1px solid #fecaca' }}>
                                    <td colSpan={5} style={{ ...td, textAlign: 'right', fontWeight: 800, color: '#991b1b' }}>Grand Total</td>
                                    <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: '#991b1b' }}>−{fmtMoney(c.amount)}</td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              <div style={{ marginTop: 18, padding: 14, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span>Items subtotal</span><strong>{fmtMoney(grn.items_subtotal || itemsSubtotal)}</strong></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: grn.cn_total > 0 ? '#dc2626' : '#9ca3af' }}><span>Credit Notes</span><strong>{grn.cn_total > 0 ? '−' : ''}{fmtMoney(grn.cn_total)}</strong></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', marginTop: 6, borderTop: '2px solid #e5e7eb', fontWeight: 700, fontSize: 15 }}>
                  <span>Final Payable</span>
                  <span style={{ color: '#16a34a' }}>{fmtMoney(grn.final_payable || (itemsSubtotal - (grn.cn_total || 0)))}</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div>
            {showVoid && (
              <button onClick={() => onVoid(row || grn)} disabled={voiding}
                style={{ padding: '8px 16px', background: voiding ? '#fca5a5' : '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: voiding ? 'wait' : 'pointer', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <FiSlash size={14} /> {voiding ? 'Voiding…' : 'Void GRN'}
              </button>
            )}
          </div>
          <button onClick={onClose}
            style={{ padding: '8px 22px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const fmtQty = (n) => parseFloat(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// ── Product Received Breakdown ──────────────────────────────────────────────
// The HQ twin of the branch GRN report (GRN.js:1041). Two steps: a row per
// product over the page's date range, then every GRN behind one product once
// one is picked.
//
// It reads GRN items, so every figure here is what a depot CONFIRMED
// receiving -- not what HQ dispatched. Those two differ by the delivery
// variance, and on this page the received number is the one that matters.
//
// Collapsed by default: this page is usually opened to read the GRN list.
function ProductReceivedPanel({ from, to, branch, branches }) {
  const [open, setOpen]         = useState(false);
  const [q, setQ]               = useState('');
  const [rows, setRows]         = useState([]);
  const [picked, setPicked]     = useState(null);
  const [lines, setLines]       = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [searched, setSearched] = useState(false);

  // The page's filters ARE the report's filters, so a change up there must
  // not leave a stale table down here claiming to answer the new question.
  useEffect(() => {
    setRows([]); setLines([]); setPicked(null); setSearched(false); setError('');
  }, [from, to, branch]);

  const scope = () => ({ from: from || undefined, to: to || undefined, branch: branch || undefined });

  const openProduct = async (productSyncId) => {
    setPicked(productSyncId);
    if (!productSyncId) { setLines([]); return; }
    try {
      const r = await getHqGrnProductBreakdown({ ...scope(), product_sync_id: productSyncId });
      setLines(r.data?.rows || []);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load the GRNs for that product.');
      setLines([]);
    }
  };

  const search = async () => {
    setLoading(true); setError('');
    try {
      const r = await getHqGrnProductReport({ ...scope(), q: q.trim() || undefined });
      const list = r.data?.rows || [];
      setRows(list);
      setSearched(true);
      // One match answers the question on its own, so open it without a
      // second click -- the branch report behaves the same way.
      if (list.length === 1) await openProduct(list[0].product_sync_id);
      else { setPicked(null); setLines([]); }
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load.');
      setRows([]); setLines([]); setPicked(null);
    }
    setLoading(false);
  };

  const pickedRow = rows.find(r => r.product_sync_id === picked);
  const totCost   = rows.reduce((s, r) => s + (parseFloat(r.total_cost)     || 0), 0);
  const totDisc   = rows.reduce((s, r) => s + (parseFloat(r.total_discount) || 0), 0);
  const branchName = branches.find(b => b.slug === branch)?.name;
  const num = { textAlign: 'right', fontFamily: 'monospace' };

  return (
    <div style={{ background: '#fff', border: '1px solid #bbf7d0', borderRadius: 10, marginBottom: 14, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                 padding: '11px 16px', background: '#f0fdf4', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <FiPackage size={15} color="#15803d" />
          <span style={{ fontWeight: 700, fontSize: 14, color: '#15803d' }}>Product Received Breakdown</span>
          <span style={{ fontSize: 12, color: '#64748b' }}>— how much of each product was received in a date range</span>
        </span>
        {open ? <FiChevronUp color="#15803d" /> : <FiChevronDown color="#15803d" />}
      </button>

      {open && (
        <div style={{ padding: 16 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <div style={{ flex: '1 1 240px', minWidth: 180 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4 }}>Product</label>
              <input value={q} onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') search(); }}
                placeholder="Part of a name, or blank for all"
                style={{ ...inp, minWidth: 180 }} />
            </div>
            <button onClick={search} disabled={loading}
              style={{ padding: '9px 18px', background: '#15803d', color: '#fff', border: 'none', borderRadius: 7,
                       cursor: loading ? 'default' : 'pointer', fontWeight: 700, fontSize: 13,
                       display: 'inline-flex', alignItems: 'center', gap: 6, opacity: loading ? 0.6 : 1 }}>
              <FiSearch size={14} /> {loading ? 'Searching…' : 'Search'}
            </button>
            <button onClick={() => { setQ(''); setRows([]); setLines([]); setPicked(null); setSearched(false); setError(''); }}
              style={{ padding: '9px 16px', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>
              Clear
            </button>
          </div>

          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 10px' }}>
            Uses the filters above: <strong>{from || 'the beginning'}</strong> to <strong>{to || 'today'}</strong>
            {branch && branch !== 'all' ? <> · <strong>{branchName || branch}</strong></> : ' · all branches'}
          </p>

          {error && <p style={{ color: '#dc2626', fontSize: 13, fontWeight: 600 }}>{error}</p>}

          {searched && !loading && rows.length === 0 && !error && (
            <p style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: 13 }}>
              Nothing was received {q.trim() ? `matching “${q.trim()}” ` : ''}in that range.
            </p>
          )}

          {rows.length > 0 && (
            <>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 9, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f0fdf4' }}>
                      <th style={th}>#</th>
                      <th style={th}>Product</th>
                      <th style={{ ...th, textAlign: 'right' }}>Qty Received</th>
                      <th style={{ ...th, textAlign: 'right' }}>GRN Count</th>
                      <th style={{ ...th, textAlign: 'right' }}>Total Cost</th>
                      <th style={{ ...th, textAlign: 'right' }}>Total Discount</th>
                      <th style={th}>First Received</th>
                      <th style={th}>Last Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const on = r.product_sync_id === picked;
                      return (
                        <tr key={r.product_sync_id || i} onClick={() => openProduct(on ? null : r.product_sync_id)}
                          style={{ borderTop: '1px solid #f1f5f9', cursor: 'pointer', background: on ? '#f0fdf4' : undefined }}>
                          <td style={{ ...td, color: '#94a3b8' }}>{i + 1}</td>
                          <td style={{ ...td, fontWeight: 700 }}>
                            {r.product_name}
                            {r.unit ? <span style={{ marginLeft: 6, fontSize: 11, color: '#64748b', fontWeight: 600 }}>{r.unit}</span> : null}
                          </td>
                          <td style={{ ...td, ...num, fontWeight: 700 }}>{fmtQty(r.qty_received)}</td>
                          <td style={{ ...td, ...num, color: '#b45309' }}>{r.grn_count}</td>
                          <td style={{ ...td, ...num, fontWeight: 700 }}>{fmtMoney(r.total_cost)}</td>
                          <td style={{ ...td, ...num, color: parseFloat(r.total_discount) > 0 ? '#dc2626' : '#94a3b8' }}>
                            {parseFloat(r.total_discount) > 0 ? fmtMoney(r.total_discount) : '—'}
                          </td>
                          <td style={td}>{r.first_received || '—'}</td>
                          <td style={td}>{r.last_received || '—'}</td>
                        </tr>
                      );
                    })}
                    <tr style={{ background: '#f8fafc', borderTop: '2px solid #e2e8f0' }}>
                      <td style={{ ...td, fontWeight: 800, color: '#15803d' }} colSpan={4}>TOTAL</td>
                      <td style={{ ...td, ...num, fontWeight: 800, color: '#15803d' }}>{fmtMoney(totCost)}</td>
                      <td style={{ ...td, ...num, fontWeight: 800, color: totDisc > 0 ? '#dc2626' : '#94a3b8' }}>
                        {totDisc > 0 ? fmtMoney(totDisc) : '—'}
                      </td>
                      <td style={td} colSpan={2} />
                    </tr>
                  </tbody>
                </table>
              </div>
              {!picked && rows.length > 1 && (
                <p style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>Click a product to see the GRNs behind it.</p>
              )}
            </>
          )}

          {picked && lines.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 8, fontWeight: 700, fontSize: 13, color: '#15803d' }}>
                <FiPackage size={13} /> GRN Breakdown — {pickedRow?.product_name}
              </div>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 9, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f0fdf4' }}>
                      <th style={th}>#</th>
                      <th style={th}>GRN Number</th>
                      <th style={th}>Invoice #</th>
                      <th style={th}>Date</th>
                      <th style={th}>Supplier</th>
                      <th style={th}>Branch</th>
                      <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                      <th style={{ ...th, textAlign: 'right' }}>Unit Price</th>
                      <th style={{ ...th, textAlign: 'right' }}>Discount</th>
                      <th style={{ ...th, textAlign: 'right' }}>Total Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={`${l.grn_sync_id}-${i}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ ...td, color: '#94a3b8' }}>{i + 1}</td>
                        <td style={{ ...td, fontWeight: 600, color: '#0ea5e9' }}>{l.grn_number}</td>
                        <td style={td}>{l.supplier_invoice_number || '—'}</td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.date}</td>
                        <td style={td}>{l.supplier_name || '—'}</td>
                        <td style={td}>{l.branch_name || l.branch_slug}</td>
                        <td style={{ ...td, ...num, fontWeight: 700 }}>{fmtQty(l.quantity)}</td>
                        <td style={{ ...td, ...num }}>{fmtMoney(l.unit_price)}</td>
                        <td style={{ ...td, ...num, color: parseFloat(l.discount_amount) > 0 ? '#dc2626' : '#94a3b8' }}>
                          {parseFloat(l.discount_amount) > 0 ? fmtMoney(l.discount_amount) : '—'}
                        </td>
                        <td style={{ ...td, ...num, fontWeight: 700 }}>{fmtMoney(l.total_price)}</td>
                      </tr>
                    ))}
                    <tr style={{ background: '#f8fafc', borderTop: '2px solid #e2e8f0' }}>
                      <td style={{ ...td, fontWeight: 800, color: '#15803d' }} colSpan={6}>
                        TOTAL — {lines.length} GRN{lines.length === 1 ? '' : 's'}
                      </td>
                      <td style={{ ...td, ...num, fontWeight: 800 }}>
                        {fmtQty(lines.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0))}
                      </td>
                      <td style={td} />
                      <td style={{ ...td, ...num, fontWeight: 800, color: '#dc2626' }}>
                        {fmtMoney(lines.reduce((s, l) => s + (parseFloat(l.discount_amount) || 0), 0))}
                      </td>
                      <td style={{ ...td, ...num, fontWeight: 800, color: '#15803d' }}>
                        {fmtMoney(lines.reduce((s, l) => s + (parseFloat(l.total_price) || 0), 0))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
