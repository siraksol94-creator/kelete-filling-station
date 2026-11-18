// ZRA Import Declarations Queue (UAT test T05A).
//
// 2026-08-26 — Built to mirror ZraPurchases.js (T06A) so both ZRA-sourced
// inbound flows look and behave the same: pull to a local queue, filter by
// status, open a detail modal, pick a destination branch, approve or
// reject.
//
// TWO deliberate differences from the purchase queue, both forced by spec:
//
//   1. BOTH decisions transmit to ZRA. /imports/updateImportItems is
//      called with imptItemSttsCd '3' (approve) or '4' (reject) — ZRA is
//      waiting on our answer for an import declaration. A purchase-queue
//      reject is local-only because ZRA already holds the supplier's side.
//   2. QUANTITY IS EDITABLE. T05A Test Procedure step 3 — "the user
//      updates the quantities accordingly" — the declared customs qty may
//      differ from what physically arrived, so approve takes an editable
//      quantity and the HQ Purchase is built from THAT figure.
//
// As with T06A, Approve moves NO stock: it creates an HQ Purchase whose
// lines sit AWAITING_GRN. Stock lands only once the destination branch
// confirms receipt and HQ generates the GRN.
//
// Red Sea sources 100% locally, so this queue realistically stays empty —
// an empty result here is the CORRECT outcome, not a failure.
import React, { useCallback, useEffect, useState } from 'react';
import { FiDownloadCloud, FiXCircle, FiRefreshCw, FiEye, FiAlertTriangle } from 'react-icons/fi';
import {
  pullZraImports, getZraImports, getZraImport,
  approveZraImport, rejectZraImport, getHqBranches,
} from '../services/api';

const STATUS_FILTERS = [
  { key: '',         label: 'All' },
  { key: 'NEW',      label: 'New' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
];

const num = (n) => (n == null || n === '' ? '—' : parseFloat(n).toLocaleString(undefined, { maximumFractionDigits: 4 }));

const statusPill = (s) => {
  const map = {
    NEW:      { bg: '#fef3c7', fg: '#92400e', label: 'NEW' },
    APPROVED: { bg: '#dcfce7', fg: '#166534', label: 'APPROVED' },
    REJECTED: { bg: '#fee2e2', fg: '#991b1b', label: 'REJECTED' },
  };
  const s2 = map[s] || { bg: '#e5e7eb', fg: '#374151', label: s || '—' };
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 12, background: s2.bg, color: s2.fg, fontSize: 11, fontWeight: 700 }}>{s2.label}</span>;
};

const ZraImports = () => {
  const [rows, setRows]       = useState([]);
  const [counts, setCounts]   = useState({});
  const [status, setStatus]   = useState('NEW');
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [message, setMessage] = useState(null);
  const [detail, setDetail]   = useState(null);
  const [busyId, setBusyId]   = useState(null);
  const [rejectPrompt, setRejectPrompt] = useState(null);
  const [branchList, setBranchList] = useState([]);
  const [destSlug, setDestSlug] = useState('');
  const [approveQty, setApproveQty] = useState('');   // T05A step 3

  useEffect(() => {
    getHqBranches().then(res => setBranchList(res.data?.branches || [])).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getZraImports(status);
      setRows(Array.isArray(res.data?.imports) ? res.data.imports : []);
      setCounts(res.data?.counts || {});
    } catch (e) {
      setMessage({ type: 'err', text: e.response?.data?.error || 'Failed to load queue' });
    } finally { setLoading(false); }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const flash = (type, text) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  };

  const doPull = async () => {
    setPulling(true);
    try {
      const res = await pullZraImports(true);
      if (res.data?.skipped) {
        flash('err', `Pull skipped: ${res.data?.reason || 'unknown'}`);
      } else {
        const pulled = res.data?.pulled ?? 0;
        const inserted = res.data?.inserted ?? 0;
        flash('ok', pulled === 0
          ? 'ZRA returned no import declarations — expected for Red Sea (100% local suppliers).'
          : `Pulled ${pulled} declaration line(s); ${inserted} new, ${res.data?.duplicates ?? 0} already known.`);
      }
      await load();
    } catch (e) {
      const err = e.response?.data;
      flash('err', `Pull failed${err?.resultCd ? ` [${err.resultCd}]` : ''}: ${err?.error || e.message}`);
    } finally { setPulling(false); }
  };

  const openDetail = async (id) => {
    setDestSlug('');
    setApproveQty('');
    setDetail({ loading: true, id });
    try {
      const res = await getZraImport(id);
      setDetail({ loading: false, ...res.data });
      // Pre-fill the editable quantity with what ZRA declared, so the
      // common case (accept as declared) is a single click.
      setApproveQty(String(res.data?.qty ?? ''));
    } catch (e) {
      flash('err', e.response?.data?.error || 'Failed to load detail');
      setDetail(null);
    }
  };

  const doApprove = async (id, destinationSlug, qty) => {
    if (!destinationSlug) { flash('err', 'Pick a destination branch first.'); return; }
    const q = parseFloat(qty);
    if (!(q > 0)) { flash('err', 'Approved quantity must be greater than zero.'); return; }
    if (!window.confirm(
      `Approve this declaration for ${destinationSlug} at qty ${q}?\n\n`
      + 'This transmits the approval to ZRA and creates an HQ Purchase. '
      + 'No stock moves yet — the branch confirms receipt, then HQ generates the GRN.'
    )) return;
    setBusyId(id);
    try {
      const res = await approveZraImport(id, destinationSlug, q);
      const poNum = res.data?.hq_purchase?.purchase_number;
      flash('ok', poNum ? `Approved on ZRA → HQ Purchase ${poNum} created.` : 'Approved on ZRA.');
      await load();
      if (detail?.id === id) setDetail(null);
    } catch (e) {
      const err = e.response?.data;
      flash('err', `Approve failed${err?.resultCd ? ` [${err.resultCd}]` : ''}: ${err?.error || e.message}`);
    } finally { setBusyId(null); }
  };

  const doReject = async (id, reason) => {
    setBusyId(id);
    try {
      await rejectZraImport(id, reason || 'no reason given');
      flash('ok', 'Rejection transmitted to ZRA.');
      await load();
      if (detail?.id === id) setDetail(null);
      setRejectPrompt(null);
    } catch (e) {
      const err = e.response?.data;
      flash('err', `Reject failed${err?.resultCd ? ` [${err.resultCd}]` : ''}: ${err?.error || e.message}`);
    } finally { setBusyId(null); }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Import Declarations Queue</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            ASYCUDA import declarations Smart Invoice holds for your TPIN. Approve or reject — both are sent back to ZRA (test T05A).
          </p>
        </div>
        <button
          onClick={doPull}
          disabled={pulling}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', border: '1.5px solid #1d4ed8', color: '#1d4ed8', background: '#eff6ff', borderRadius: 8, cursor: pulling ? 'wait' : 'pointer', fontWeight: 700, fontSize: 13 }}
        >
          {pulling ? <FiRefreshCw size={16} /> : <FiDownloadCloud size={16} />} {pulling ? 'Pulling…' : 'Pull Imports'}
        </button>
      </div>

      {message && (
        <div style={{
          marginBottom: 14, padding: '10px 14px', borderRadius: 8, fontSize: 13,
          background: message.type === 'ok' ? '#dcfce7' : '#fee2e2',
          color:      message.type === 'ok' ? '#166534' : '#991b1b',
          border: `1px solid ${message.type === 'ok' ? '#86efac' : '#fecaca'}`,
        }}>{message.text}</div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setStatus(f.key)}
            style={{
              padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: status === f.key ? '#1d4ed8' : '#fff',
              color:      status === f.key ? '#fff'    : '#374151',
            }}
          >{f.label}{f.key && counts[f.key] ? ` (${counts[f.key]})` : ''}</button>
        ))}
      </div>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: '#f9fafb' }}>
              <tr>
                <th style={th}>Pulled</th>
                <th style={th}>Decl. Date</th>
                <th style={th}>Declaration #</th>
                <th style={th}>Item</th>
                <th style={th}>HS Code</th>
                <th style={{ ...th, textAlign: 'right' }}>Declared Qty</th>
                <th style={th}>Origin</th>
                <th style={th}>Supplier / Agent</th>
                <th style={th}>Status</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
                  Nothing here. Click <strong>Pull Imports</strong> to fetch from ZRA.
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    An empty queue is expected — Red Sea sources 100% locally, so ZRA holds no ASYCUDA declarations for this TPIN.
                  </div>
                </td></tr>
              )}
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={td}>{(r.pulled_at || '').slice(0, 16).replace('T', ' ')}</td>
                  <td style={td}>{r.dcl_de || '—'}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{r.dcl_no || '—'}</td>
                  <td style={{ ...td, fontWeight: 600 }}>
                    {r.item_nm || r.item_cd || '—'}
                    <div style={{ fontSize: 10, color: '#6b7280', fontFamily: 'monospace' }}>seq {r.item_seq ?? '—'}</div>
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{r.hs_cd || '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {num(r.qty)} {r.qty_unit_cd || ''}
                    {r.status === 'APPROVED' && r.approved_qty != null && parseFloat(r.approved_qty) !== parseFloat(r.qty) && (
                      <div style={{ fontSize: 10, color: '#b45309' }}>approved {num(r.approved_qty)}</div>
                    )}
                  </td>
                  <td style={td}>{r.orgn_nat_cd || '—'}</td>
                  <td style={td}>{r.spplr_nm || r.agnt_nm || '—'}</td>
                  <td style={td}>
                    {statusPill(r.status)}
                    {r.hq_purchase_number && (
                      <div style={{ fontSize: 10, marginTop: 2 }}>
                        <span style={{ color: '#374151' }}>PO </span>
                        <span style={{ fontFamily: 'monospace', color: '#1d4ed8' }}>{r.hq_purchase_number}</span>
                      </div>
                    )}
                    {r.destination_slug && (
                      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>→ {r.destination_name || r.destination_slug}</div>
                    )}
                    {r.error && (
                      <div title={r.error} style={{ fontSize: 10, color: '#991b1b', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <FiAlertTriangle size={10} /> Error
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <button onClick={() => openDetail(r.id)} style={btnIcon('#374151')} title="View / approve / reject">
                      <FiEye size={14} />
                    </button>
                    {r.status === 'NEW' && (
                      <button
                        onClick={() => setRejectPrompt({ id: r.id, reason: '' })}
                        disabled={busyId === r.id}
                        style={btnIcon('#dc2626')}
                        title="Reject — transmits to ZRA"
                      ><FiXCircle size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail modal */}
      {detail && (
        <div style={modalBackdrop} onClick={() => setDetail(null)}>
          <div style={modalBody} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Import Declaration</div>
                <h3 style={{ margin: '3px 0 0' }}>{detail.item_nm || detail.item_cd || '—'} · {detail.dcl_no || '—'}</h3>
              </div>
              <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#6b7280' }}>×</button>
            </div>
            <div style={{ padding: 20, maxHeight: '70vh', overflowY: 'auto' }}>
              {detail.loading ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 18, fontSize: 12 }}>
                    <Kv label="Task Code"   value={detail.task_cd} mono />
                    <Kv label="Decl. Date"  value={detail.dcl_de} />
                    <Kv label="Decl. Ref"   value={detail.dcl_ref_num} mono />
                    <Kv label="Item Code"   value={detail.item_cd} mono />
                    <Kv label="Class Code"  value={detail.item_cls_cd} mono />
                    <Kv label="HS Code"     value={detail.hs_cd} mono />
                    <Kv label="Origin"      value={detail.orgn_nat_cd} />
                    <Kv label="Export From" value={detail.expt_nat_cd} />
                    <Kv label="Declared Qty" value={`${num(detail.qty)} ${detail.qty_unit_cd || ''}`} bold />
                    <Kv label="Packages"    value={`${num(detail.pkg)} ${detail.pkg_unit_cd || ''}`} />
                    <Kv label="Net Weight"  value={num(detail.net_wt)} />
                    <Kv label="Gross Weight" value={num(detail.tot_wt)} />
                    <Kv label="Supplier"    value={detail.spplr_nm} />
                    <Kv label="Agent"       value={detail.agnt_nm} />
                    <Kv label="Invoice (FC)" value={detail.invc_fcur_amt != null ? `${num(detail.invc_fcur_amt)} ${detail.invc_fcur_cd || ''}` : null} />
                    <Kv label="FX Rate"     value={num(detail.invc_fcur_excrt)} />
                  </div>

                  {detail.status === 'NEW' && (
                    <div style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
                      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
                        <div style={{ flex: '1 1 240px' }}>
                          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Destination Branch *</label>
                          <select value={destSlug} onChange={e => setDestSlug(e.target.value)}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}>
                            <option value="">— select branch —</option>
                            {branchList.map(b => <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>)}
                          </select>
                        </div>
                        {/* T05A step 3 — the declared customs quantity may
                            differ from what physically arrived. */}
                        <div style={{ flex: '0 1 180px' }}>
                          <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 4 }}>
                            Approved Qty * <span style={{ fontWeight: 400, color: '#6b7280' }}>({detail.qty_unit_cd || 'units'})</span>
                          </label>
                          <input
                            type="number" min="0.0001" step="any"
                            value={approveQty}
                            onChange={e => setApproveQty(e.target.value)}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }}
                          />
                          {parseFloat(approveQty) !== parseFloat(detail.qty) && approveQty !== '' && (
                            <div style={{ fontSize: 10, color: '#b45309', marginTop: 3 }}>
                              Differs from declared {num(detail.qty)}
                            </div>
                          )}
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12, lineHeight: 1.6 }}>
                        Approving transmits the decision to ZRA and creates an HQ Purchase for the chosen branch.
                        <strong> No stock moves yet</strong> — the branch confirms received quantity, then HQ generates the GRN.
                      </div>
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => setRejectPrompt({ id: detail.id, reason: '' })}
                          style={{ padding: '9px 16px', border: '1px solid #fecaca', color: '#dc2626', background: '#fff', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
                        >Reject</button>
                        <button
                          onClick={() => doApprove(detail.id, destSlug, approveQty)}
                          disabled={busyId === detail.id || !destSlug || !(parseFloat(approveQty) > 0)}
                          title={!destSlug ? 'Pick a destination branch first' : undefined}
                          style={{ padding: '9px 16px', border: 'none', background: (busyId === detail.id || !destSlug || !(parseFloat(approveQty) > 0)) ? '#9ca3af' : '#16a34a', color: '#fff', borderRadius: 8, cursor: (busyId === detail.id || !destSlug) ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13 }}
                        >{busyId === detail.id ? 'Approving…' : 'Approve → HQ Purchase'}</button>
                      </div>
                    </div>
                  )}

                  {detail.status !== 'NEW' && (
                    <div style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #e5e7eb', fontSize: 12, color: '#374151', lineHeight: 1.8 }}>
                      <div>Decision: {statusPill(detail.status)} on {(detail.decided_at || '').slice(0, 16).replace('T', ' ') || '—'}</div>
                      {detail.approved_qty != null && <div>Approved quantity: <strong>{num(detail.approved_qty)}</strong></div>}
                      {detail.hq_purchase_number && <div>HQ Purchase: <strong style={{ fontFamily: 'monospace' }}>{detail.hq_purchase_number}</strong></div>}
                      {detail.match_summary && <div style={{ color: '#6b7280' }}>{detail.match_summary}</div>}
                    </div>
                  )}

                  {detail.error && (
                    <div style={{ marginTop: 12, padding: 10, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#991b1b' }}>
                      <strong>Last error:</strong> {detail.error}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reject prompt */}
      {rejectPrompt && (
        <div style={modalBackdrop} onClick={() => setRejectPrompt(null)}>
          <div style={{ ...modalBody, maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
              <h3 style={{ margin: 0 }}>Reject declaration</h3>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                Unlike a supplier purchase, this <strong>is transmitted to ZRA</strong> — they are waiting on your decision for this declaration.
              </div>
            </div>
            <div style={{ padding: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 6 }}>Reason</label>
              <textarea
                rows={3}
                value={rejectPrompt.reason}
                onChange={e => setRejectPrompt({ ...rejectPrompt, reason: e.target.value })}
                placeholder="e.g. goods never arrived; declaration belongs to another importer"
                style={{ width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
                <button onClick={() => setRejectPrompt(null)}
                        style={{ padding: '8px 14px', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                <button onClick={() => doReject(rejectPrompt.id, rejectPrompt.reason)}
                        disabled={busyId === rejectPrompt.id}
                        style={{ padding: '8px 14px', border: 'none', background: '#dc2626', color: '#fff', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                  {busyId === rejectPrompt.id ? 'Rejecting…' : 'Reject on ZRA'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const th = { padding: '10px 12px', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#6b7280', fontWeight: 700 };
const td = { padding: '10px 12px', color: '#111827' };
const btnIcon = (color) => ({ padding: '6px 8px', marginRight: 4, border: `1px solid ${color}33`, background: '#fff', color, borderRadius: 6, cursor: 'pointer' });
const modalBackdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modalBody = { background: '#fff', borderRadius: 12, width: '100%', maxWidth: 900, boxShadow: '0 24px 64px rgba(0,0,0,0.4)' };

const Kv = ({ label, value, mono, bold }) => (
  <div>
    <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>{label}</div>
    <div style={{ fontSize: 13, marginTop: 2, fontFamily: mono ? 'monospace' : 'inherit', fontWeight: bold ? 700 : 400, color: '#111827' }}>{value ?? '—'}</div>
  </div>
);

export default ZraImports;
