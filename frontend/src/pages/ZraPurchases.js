// v1.13.81 — ZRA Purchase Queue (UAT test T06A).
//
// Every invoice VSDC-registered suppliers (Zambian Breweries etc) have
// issued against our TPIN lands here.
//
// v1.13.155 — corrected stale description below. Approve does NOT fire
// savePurchase immediately (that changed in the Phase 1/2 rewrite,
// commits 95fe9d3 + 9e76d71): it creates an HQ Purchase (destination
// branch required) that flows through the normal 3-step chain — branch
// confirms received qty, HQ generates the GRN, and THAT is when
// savePurchase + saveStockItems + saveStockMaster actually fire to ZRA.
// Approve here just gets the invoice into that pipeline with the ZRA
// classification data pre-filled.
import React, { useCallback, useEffect, useState } from 'react';
import { FiDownloadCloud, FiXCircle, FiRefreshCw, FiEye, FiAlertTriangle } from 'react-icons/fi';
import {
  pullZraPurchases, getZraPurchases, getZraPurchase,
  approveZraPurchase, rejectZraPurchase, getHqBranches, getProducts,
} from '../services/api';

const STATUS_FILTERS = [
  { key: '',         label: 'All' },
  { key: 'NEW',      label: 'New' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
];

const money = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const statusPill = (s) => {
  const map = {
    NEW:      { bg: '#fef3c7', fg: '#92400e', label: 'NEW' },
    APPROVED: { bg: '#dcfce7', fg: '#166534', label: 'APPROVED' },
    REJECTED: { bg: '#fee2e2', fg: '#991b1b', label: 'REJECTED' },
  };
  const s2 = map[s] || { bg: '#e5e7eb', fg: '#374151', label: s || '—' };
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 12, background: s2.bg, color: s2.fg, fontSize: 11, fontWeight: 700 }}>{s2.label}</span>;
};

const ZraPurchases = () => {
  const [rows, setRows]           = useState([]);
  const [status, setStatus]       = useState('NEW');
  const [loading, setLoading]     = useState(false);
  const [pulling, setPulling]     = useState(false);
  const [message, setMessage]     = useState(null);   // {type:'ok'|'err', text}
  const [detail, setDetail]       = useState(null);   // full row with item_list
  const [busyId, setBusyId]       = useState(null);   // id currently being approved/rejected
  const [rejectPrompt, setRejectPrompt] = useState(null); // { id, reason }
  const [branchList, setBranchList] = useState([]);   // v1.13.155 — destination picker options
  const [destSlug, setDestSlug]   = useState('');      // v1.13.155 — chosen destination for the open detail row
  // 2026-08-26 — per-line supplier→our-product mapping.
  // productList is the HQ catalogue; hq_products.sync_id is the SAME
  // sync_id pushed to every branch, so one list serves all destinations.
  const [productList, setProductList] = useState([]);
  // lineMap: { [itemCd]: { action: 'MAP'|'CREATE'|'IGNORE', product_sync_id } }
  const [lineMap, setLineMap] = useState({});

  useEffect(() => {
    getHqBranches().then(res => setBranchList(res.data?.branches || [])).catch(() => {});
    // 2026-08-26 — was getHqProducts() (masterDb hq_products), which is
    // empty on this deployment: Red Sea's items are created through the
    // ordinary Item Details page on the HQ host, so they live in HQ's own
    // products table, not the hq_products master. That left the mapping
    // dropdown with nothing to pick. /products on the HQ host reads that
    // table, and its sync_id is the same one pushed to every branch — so
    // one list still serves all destinations.
    getProducts()
      .then(res => {
        const rows = Array.isArray(res.data) ? res.data : (res.data?.products || []);
        setProductList(rows.filter(p => p.status !== 'Deleted'));
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getZraPurchases(status);
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setMessage({ type: 'err', text: e.response?.data?.error || 'Failed to load queue' });
    } finally { setLoading(false); }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const flash = (type, text) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4500);
  };

  const doPull = async (full = false) => {
    setPulling(true);
    try {
      const res = await pullZraPurchases(full);
      const skipped = res.data?.skipped;
      if (skipped) {
        flash('err', `Pull skipped: ${res.data?.reason || 'unknown'}`);
      } else {
        flash('ok', `Pulled ${res.data?.pulled ?? 0} invoice(s); upserted ${res.data?.upserted ?? 0}.`);
      }
      await load();
    } catch (e) {
      const err = e.response?.data;
      flash('err', `Pull failed${err?.resultCd ? ` [${err.resultCd}]` : ''}: ${err?.error || e.message}`);
    } finally { setPulling(false); }
  };

  const openDetail = async (id) => {
    setDestSlug('');
    setLineMap({});
    setDetail({ loading: true, id });
    try {
      const res = await getZraPurchase(id);
      setDetail({ loading: false, ...res.data });
      // Seed the picker from the backend's suggestions. A 'saved'
      // suggestion is a decision the operator already made for this
      // supplier+code, so it counts as decided. A 'name' suggestion is
      // only a guess off the supplier's own naming — it pre-fills the
      // dropdown but is deliberately NOT treated as decided, so Approve
      // stays disabled until a human confirms it.
      const seeded = {};
      for (const it of (res.data?.item_list || [])) {
        if (!it.itemCd) continue;
        if (it.map_suggestion === 'saved' && it.map_action) {
          seeded[it.itemCd] = { action: it.map_action, product_sync_id: it.map_product_sync_id || null };
        }
      }
      setLineMap(seeded);
    } catch (e) {
      flash('err', e.response?.data?.error || 'Failed to load detail');
      setDetail(null);
    }
  };

  // A line counts as decided once it has an action, and — for MAP — a
  // chosen product. Mirrors the backend's own validation.
  const lineDecided = (it) => {
    const d = lineMap[it.itemCd];
    if (!d || !d.action) return false;
    return d.action !== 'MAP' || !!d.product_sync_id;
  };
  const allLinesDecided = (detail?.item_list || []).every(lineDecided);
  const undecidedCount = (detail?.item_list || []).filter(it => !lineDecided(it)).length;

  const setLine = (itemCd, patch) =>
    setLineMap(m => ({ ...m, [itemCd]: { ...(m[itemCd] || {}), ...patch } }));

  // One dropdown per line. The value encodes the whole decision so the
  // three special options and the product list can share one control:
  //   ''              → undecided
  //   '__CREATE__'    → bring in as a new product
  //   '__IGNORE__'    → leave this line off the PO entirely
  //   <sync_id>       → map to that existing product
  // Units available for a line: the mapped product's own packagings
  // (units_json = [{name, conv, is_base}]), falling back to the
  // supplier's unit when nothing is mapped yet.
  const unitsForLine = (it) => {
    const d = lineMap[it.itemCd] || {};
    if (d.action === 'MAP' && d.product_sync_id) {
      const p = productList.find(x => x.sync_id === d.product_sync_id);
      if (p) {
        let arr = [];
        try { arr = JSON.parse(p.units_json || '[]'); } catch { arr = []; }
        const names = arr.map(u => u.name).filter(Boolean);
        if (names.length) return names;
        if (p.unit) return [p.unit];
      }
    }
    return [it.qtyUnitCd || 'pcs'];
  };

  // Quantity + unit as physically received, in OUR packaging. The
  // supplier's figure pre-fills it; changing the unit does NOT convert
  // the number automatically — the operator states what actually
  // arrived, which is the only figure we can trust.
  const renderReceiveCell = (it) => {
    if (!it.itemCd) return null;
    const d = lineMap[it.itemCd] || {};
    if (d.action === 'IGNORE') return <span style={{ color: '#9ca3af', fontSize: 11 }}>—</span>;
    const units = unitsForLine(it);
    const qty = d.receive_qty ?? it.qty ?? '';
    const unit = d.receive_unit || units[0] || '';
    const changed = String(qty) !== String(it.qty) || unit !== (it.qtyUnitCd || '');
    return (
      <div>
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            type="number" min="0" step="any"
            value={qty}
            onChange={e => setLine(it.itemCd, { receive_qty: e.target.value })}
            style={{ width: 70, padding: '6px 6px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }}
          />
          <select
            value={unit}
            onChange={e => setLine(it.itemCd, { receive_unit: e.target.value })}
            style={{ flex: 1, minWidth: 80, padding: '6px 6px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }}
          >
            {units.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 10, marginTop: 2, color: changed ? '#b45309' : '#6b7280' }}>
          {changed ? `supplier billed ${it.qty} ${it.qtyUnitCd || ''}` : 'same as invoice'}
        </div>
      </div>
    );
  };

  const renderMapCell = (it) => {
    if (!it.itemCd) return <span style={{ color: '#9ca3af', fontSize: 11 }}>no item code</span>;
    const d = lineMap[it.itemCd] || {};
    const value = d.action === 'CREATE' ? '__CREATE__'
                : d.action === 'IGNORE' ? '__IGNORE__'
                : (d.product_sync_id || '');
    const decided = lineDecided(it);
    // A 'name' suggestion pre-fills the dropdown but is NOT counted as
    // decided — supplier naming is not authoritative for our catalogue,
    // so a human confirms it. 'saved' is a prior decision, so it is.
    const suggested = !decided && it.map_suggestion === 'name' ? it.map_product_sync_id : '';
    const onChange = (v) => {
      if (v === '__CREATE__')      setLine(it.itemCd, { action: 'CREATE', product_sync_id: null });
      else if (v === '__IGNORE__') setLine(it.itemCd, { action: 'IGNORE', product_sync_id: null });
      else if (v)                  setLine(it.itemCd, { action: 'MAP', product_sync_id: v });
      else                         setLine(it.itemCd, { action: null, product_sync_id: null });
    };
    return (
      <div>
        <select
          value={value || suggested}
          onChange={e => onChange(e.target.value)}
          style={{
            width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12,
            border: `1.5px solid ${decided ? '#86efac' : '#fbbf24'}`,
            background: decided ? '#f0fdf4' : '#fffbeb',
          }}
        >
          <option value="">— choose —</option>
          <option value="__CREATE__">＋ Create as new product</option>
          <option value="__IGNORE__">⊘ Ignore this line</option>
          <option disabled>──────────</option>
          {productList.map(p => (
            <option key={p.sync_id} value={p.sync_id}>{p.name}</option>
          ))}
        </select>
        <div style={{ fontSize: 10, marginTop: 2 }}>
          {decided && it.map_suggestion === 'saved' && (
            <span style={{ color: '#166534' }}>✓ remembered from last time</span>
          )}
          {decided && it.map_suggestion !== 'saved' && (
            <span style={{ color: '#166534' }}>✓ set</span>
          )}
          {!decided && it.map_suggestion === 'name' && (
            <span style={{ color: '#b45309' }}>
              suggested by name — confirm it
            </span>
          )}
          {!decided && it.map_suggestion !== 'name' && (
            <span style={{ color: '#b45309' }}>needs mapping</span>
          )}
        </div>
      </div>
    );
  };

  // v1.13.155 — requires destination_slug (which branch these goods
  // ship to). No ZRA call fires here — this only creates the HQ
  // Purchase; savePurchase + stock chain fire later at HQ Generate GRN.
  const doApprove = async (id, destinationSlug) => {
    if (!destinationSlug) { flash('err', 'Pick a destination branch first.'); return; }
    if (!allLinesDecided) { flash('err', 'Every line must be mapped first.'); return; }
    const payload = (detail?.item_list || []).map(it => ({
      itemCd: it.itemCd,
      action: lineMap[it.itemCd]?.action,
      product_sync_id: lineMap[it.itemCd]?.product_sync_id || null,
      receive_qty:  lineMap[it.itemCd]?.receive_qty  ?? it.qty,
      receive_unit: lineMap[it.itemCd]?.receive_unit || null,
    }));
    const ignored = payload.filter(l => l.action === 'IGNORE').length;
    const created = payload.filter(l => l.action === 'CREATE').length;
    if (!window.confirm(
      `Approve this invoice for ${destinationSlug}?

`
      + `${payload.length - ignored - created} mapped to existing products`
      + `${created ? `, ${created} created as new` : ''}`
      + `${ignored ? `, ${ignored} ignored` : ''}.

`
      + 'Your choices are saved, so the next invoice from this supplier maps itself. '
      + 'This creates an HQ Purchase — the branch confirms received qty, then HQ generates the GRN, '
      + 'which is when the ZRA savePurchase + stock chain fire.'
    )) return;
    setBusyId(id);
    try {
      const res = await approveZraPurchase(id, destinationSlug, payload);
      const poNum = res.data?.hq_purchase?.purchase_number;
      flash('ok', poNum ? `Approved → HQ Purchase ${poNum} created.` : 'Approved.');
      await load();
      if (detail?.id === id) setDetail(null);
    } catch (e) {
      flash('err', e.response?.data?.error || 'Approve failed');
    } finally { setBusyId(null); }
  };

  const doReject = async (id, reason) => {
    setBusyId(id);
    try {
      await rejectZraPurchase(id, reason || 'no reason given');
      flash('ok', 'Rejected locally (ZRA already holds the supplier side).');
      await load();
      if (detail?.id === id) setDetail(null);
      setRejectPrompt(null);
    } catch (e) {
      flash('err', e.response?.data?.error || 'Reject failed');
    } finally { setBusyId(null); }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Supplier Purchase Queue</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Invoices VSDC-registered suppliers have issued to your TPIN. Approve to register on ZRA (test T06A).
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => doPull(false)}
            disabled={pulling}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', border: '1.5px solid #1d4ed8', color: '#1d4ed8', background: '#eff6ff', borderRadius: 8, cursor: pulling ? 'wait' : 'pointer', fontWeight: 700, fontSize: 13 }}
          >
            <FiDownloadCloud size={16} /> {pulling ? 'Pulling…' : 'Pull New'}
          </button>
          <button
            onClick={() => doPull(true)}
            disabled={pulling}
            title="Reset the lastReqDt bookmark to epoch and re-fetch everything"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', border: '1px solid #d1d5db', background: '#fff', borderRadius: 8, cursor: pulling ? 'wait' : 'pointer', fontSize: 13 }}
          >
            <FiRefreshCw size={14} /> Full Refresh
          </button>
        </div>
      </div>

      {/* Message */}
      {message && (
        <div style={{
          marginBottom: 14, padding: '10px 14px', borderRadius: 8, fontSize: 13,
          background: message.type === 'ok' ? '#dcfce7' : '#fee2e2',
          color:      message.type === 'ok' ? '#166534' : '#991b1b',
          border: `1px solid ${message.type === 'ok' ? '#86efac' : '#fecaca'}`,
        }}>{message.text}</div>
      )}

      {/* Status filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {STATUS_FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setStatus(f.key)}
            style={{
              padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: status === f.key ? '#1d4ed8' : '#fff',
              color:      status === f.key ? '#fff'    : '#374151',
            }}
          >{f.label}</button>
        ))}
      </div>

      {/* Table */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: '#f9fafb' }}>
              <tr>
                <th style={th}>Pulled</th>
                <th style={th}>Sales Date</th>
                <th style={th}>Supplier</th>
                <th style={th}>TPIN</th>
                <th style={th}>Bhf</th>
                <th style={th}>Invoice #</th>
                <th style={{ ...th, textAlign: 'right' }}>Items</th>
                <th style={{ ...th, textAlign: 'right' }}>Total (ZMW)</th>
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
                  Nothing here. Click <strong>Pull New</strong> to fetch from VSDC.
                </td></tr>
              )}
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={td}>{(r.pulled_at || '').slice(0, 16).replace('T', ' ')}</td>
                  <td style={td}>{r.sales_dt || '—'}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{r.spplr_nm || '—'}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{r.spplr_tpin || '—'}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{r.spplr_bhf_id || '—'}</td>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{r.spplr_invc_no || '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.tot_item_cnt ?? '—'}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(r.tot_amt)}</td>
                  <td style={td}>
                    {statusPill(r.status)}
                    {r.status === 'APPROVED' && r.approved_pchs_invc_no && (
                      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2, fontFamily: 'monospace' }}>ZRA #{r.approved_pchs_invc_no}</div>
                    )}
                    {r.grn_number && (
                      <div style={{ fontSize: 10, marginTop: 2 }}>
                        <span style={{ color: '#374151' }}>Draft </span>
                        <span style={{ fontFamily: 'monospace', color: '#1d4ed8' }}>{r.grn_number}</span>
                      </div>
                    )}
                    {r.match_summary && (
                      <div title={r.match_summary} style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                        {r.match_summary.split(' — ')[0]}
                      </div>
                    )}
                    {r.error && (
                      <div title={r.error} style={{ fontSize: 10, color: '#991b1b', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <FiAlertTriangle size={10} /> Error
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {/* v1.13.155 — row-level one-click Approve removed:
                        approving now requires picking a destination
                        branch, which only the detail modal below can
                        ask for. Eye icon opens that modal for both
                        viewing and approving/rejecting. */}
                    <button onClick={() => openDetail(r.id)}
                            style={btnIcon('#374151')} title="View item list / approve / reject">
                      <FiEye size={14} />
                    </button>
                    {r.status === 'NEW' && (
                      <>
                        <button
                          onClick={() => setRejectPrompt({ id: r.id, reason: '' })}
                          disabled={busyId === r.id}
                          style={btnIcon('#dc2626')}
                          title="Reject — local audit only"
                        ><FiXCircle size={14} /></button>
                      </>
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
          <div style={modalBodyWide} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Supplier Invoice</div>
                <h3 style={{ margin: '3px 0 0' }}>{detail.spplr_nm || '—'} · {detail.spplr_invc_no || '—'}</h3>
                {/* 2026-08-30 — what approval will do with the SUPPLIER.
                    The link is resolved server-side at approval; without this
                    line there was no way to tell an existing supplier from one
                    about to be created until after it happened. */}
                {detail.supplier_match && (() => {
                  const m = detail.supplier_match;
                  const isNew = m.how === 'WILL_CREATE';
                  const why =
                      m.how === 'REMEMBERED' ? 'mapped before'
                    : m.how === 'TPIN'       ? 'same TPIN'
                    : m.how === 'NAME'       ? 'name match'
                    : 'new supplier';
                  return (
                    <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6,
                                  fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 12,
                                  background: isNew ? '#fef3c7' : '#dcfce7',
                                  color:      isNew ? '#92400e' : '#166534',
                                  border: `1px solid ${isNew ? '#fde68a' : '#bbf7d0'}` }}>
                      {isNew ? 'Will create supplier' : 'Supplier matched'}: {m.name} · {why}
                    </div>
                  );
                })()}
              </div>
              <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#6b7280' }}>×</button>
            </div>
            <div style={{ padding: 20, maxHeight: '70vh', overflowY: 'auto' }}>
              {detail.loading ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 18, fontSize: 12 }}>
                    <Kv label="TPIN"      value={detail.spplr_tpin} mono />
                    <Kv label="Bhf ID"    value={detail.spplr_bhf_id} mono />
                    <Kv label="SDC ID"    value={detail.spplr_sdc_id} mono />
                    <Kv label="Sales Dt"  value={detail.sales_dt} />
                    <Kv label="Stock Rls" value={detail.stock_rls_dt} />
                    <Kv label="Pmt"       value={detail.pmt_ty_cd} />
                    <Kv label="Taxable"   value={money(detail.tot_taxbl_amt)} />
                    <Kv label="Tax"       value={money(detail.tot_tax_amt)} />
                    <Kv label="Total"     value={money(detail.tot_amt)} bold />
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>Line items</div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden' }}>
                    <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead style={{ background: '#f9fafb' }}>
                        <tr>
                          <th style={th}>#</th>
                          <th style={th}>Code</th>
                          <th style={th}>Name</th>
                          <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                          <th style={th}>Unit</th>
                          <th style={{ ...th, textAlign: 'right' }}>Price</th>
                          <th style={th}>VAT</th>
                          <th style={{ ...th, textAlign: 'right' }}>VAT amt</th>
                          {/* 2026-08-31 — the pulled line carries a discount and
                              it is now read into the purchase cost, so it has
                              to be visible before anyone approves the line. */}
                          <th style={{ ...th, textAlign: 'right' }}>Discount</th>
                          <th style={{ ...th, textAlign: 'right' }}>Total</th>
                          <th style={{ ...th, minWidth: 240 }}>Map to our item *</th>
                          <th style={{ ...th, minWidth: 170 }}>Receive as *</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.item_list || []).map((it, i) => (
                          <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                            <td style={td}>{it.itemSeq ?? i + 1}</td>
                            <td style={{ ...td, fontFamily: 'monospace' }}>{it.itemCd || '—'}</td>
                            <td style={td}>{it.itemNm || '—'}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{it.qty ?? '—'}</td>
                            <td style={td}>{it.qtyUnitCd || '—'}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{money(it.prc)}</td>
                            <td style={td}>{it.vatCatCd || '—'}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{money(it.taxAmt ?? it.vatAmt)}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{money(it.dcAmt ?? it.discountAmt)}</td>
                            <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(it.totAmt)}</td>
                            <td style={td}>{renderMapCell(it)}</td>
                            <td style={td}>{renderReceiveCell(it)}</td>
                          </tr>
                        ))}
                        {(!detail.item_list || detail.item_list.length === 0) && (
                          <tr><td colSpan={11} style={{ padding: 16, textAlign: 'center', color: '#9ca3af' }}>No line items in raw payload.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {detail.status === 'NEW' && (
                    <div style={{ marginTop: 20 }}>
                      {/* v1.13.155 — destination branch picker. Required:
                          approve creates an HQ Purchase, which needs to
                          know where these goods physically ship to. */}
                      <div style={{ marginBottom: 12 }}>
                        <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Destination Branch *</label>
                        <select value={destSlug} onChange={e => setDestSlug(e.target.value)}
                          style={{ width: '100%', maxWidth: 280, padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}>
                          <option value="">— select branch —</option>
                          {branchList.map(b => <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>)}
                        </select>
                      </div>
                      {undecidedCount > 0 && (
                        <div style={{ marginBottom: 10, padding: '8px 12px', background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
                          ⚠ {undecidedCount} line{undecidedCount > 1 ? 's' : ''} still need mapping. Supplier item codes are theirs, not ours — pick which of your products each line is, or mark it new/ignored.
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => setRejectPrompt({ id: detail.id, reason: '' })}
                          style={{ padding: '9px 16px', border: '1px solid #fecaca', color: '#dc2626', background: '#fff', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
                        >Reject</button>
                        <button
                          onClick={() => doApprove(detail.id, destSlug)}
                          disabled={busyId === detail.id || !destSlug || !allLinesDecided}
                          title={!destSlug ? 'Pick a destination branch first'
                               : !allLinesDecided ? 'Map every line first' : undefined}
                          style={{ padding: '9px 16px', border: 'none', background: (busyId === detail.id || !destSlug || !allLinesDecided) ? '#9ca3af' : '#16a34a', color: '#fff', borderRadius: 8, cursor: (busyId === detail.id || !destSlug || !allLinesDecided) ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13 }}
                        >{busyId === detail.id ? 'Approving…' : 'Approve → HQ Purchase'}</button>
                      </div>
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
              <h3 style={{ margin: 0 }}>Reject purchase</h3>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                Marks the row REJECTED locally. ZRA already holds the supplier's side — this is a bookkeeping note.
              </div>
            </div>
            <div style={{ padding: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 6 }}>Reason</label>
              <textarea
                rows={3}
                value={rejectPrompt.reason}
                onChange={e => setRejectPrompt({ ...rejectPrompt, reason: e.target.value })}
                placeholder="e.g. duplicate of INV-1234; goods not received"
                style={{ width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
                <button onClick={() => setRejectPrompt(null)}
                        style={{ padding: '8px 14px', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                <button onClick={() => doReject(rejectPrompt.id, rejectPrompt.reason)}
                        disabled={busyId === rejectPrompt.id}
                        style={{ padding: '8px 14px', border: 'none', background: '#dc2626', color: '#fff', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                  {busyId === rejectPrompt.id ? 'Rejecting…' : 'Reject'}
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
// The detail modal carries the line table plus two decision columns
// (map + receive qty/unit), so it needs considerably more room than the
// small reject prompt that also uses modalBody.
const modalBodyWide = { ...modalBody, maxWidth: 1400 };

const Kv = ({ label, value, mono, bold }) => (
  <div>
    <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>{label}</div>
    <div style={{ fontSize: 13, marginTop: 2, fontFamily: mono ? 'monospace' : 'inherit', fontWeight: bold ? 700 : 400, color: '#111827' }}>{value ?? '—'}</div>
  </div>
);

export default ZraPurchases;
