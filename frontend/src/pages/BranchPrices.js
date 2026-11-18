// v1.13.154 — Branch Prices. HQ sets the selling price for ONE branch.
//
// HQ previously had two levers and both were all-or-nothing: ticking "push
// price to all" on Item Details sent one product's price to every branch, and
// Push Prices to All Branches sent every product to every branch. Neither
// could say "Chipata sells Flying Fish at 350, leave the others" — which is
// what the depots actually need, since Chipata is the only one that sent a
// price list and it differs from HQ on thirteen items.
//
// HQ's own price sits beside the branch's so a typo stands out, and the
// difference column is the whole point of the screen: it answers "where does
// this branch disagree with HQ" without reading two lists side by side.
//
// Prices are already branch-owned — mirrorAllHqToBranches takes pushPrices =
// false and leaves each branch's price alone — so nothing here fights the
// mirror. The one thing that DOES overwrite this work is the Push Prices to
// All Branches button on Item Details, which is why the warning below says so.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getHqBranches, getBranchPrices, saveBranchPrices, multiPushBranchPrices } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiSearch, FiSave, FiRefreshCw, FiUploadCloud, FiX, FiAlertTriangle } from 'react-icons/fi';
import { matchTokens } from '../utils/tokenSearch';

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const money = (v) => num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const BranchPrices = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();

  const [branches, setBranches] = useState([]);
  const [branch, setBranch]     = useState('');
  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [search, setSearch]     = useState('');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [toast, setToast]       = useState(null);

  // Map<sync_id, price>, with its "as loaded" twin so a cell counts as changed
  // only when it differs from what the branch actually holds.
  const [prices, setPrices]   = useState({});
  const [initial, setInitial] = useState({});
  const [editing, setEditing] = useState(null);
  const [editRaw, setEditRaw] = useState('');

  // 2026-09-04 — what the last Save committed, and therefore what Multi Push
  // is allowed to send. Deliberately populated on save rather than on edit:
  // a price still being typed must never be pushable, and the operator should
  // only ever distribute a figure they have already committed and seen.
  const [pushable, setPushable] = useState([]);   // [{ sync_id, code, name, base_price }]
  const [pushOpen, setPushOpen] = useState(false);
  const [pushTo, setPushTo]     = useState([]);   // slugs — starts EMPTY on purpose
  const [pushing, setPushing]   = useState(false);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    getHqBranches()
      .then(res => {
        const list = Array.isArray(res.data) ? res.data : (res.data?.branches || []);
        // HQ leads the list — it is where a price change normally starts, and
        // the backend now accepts it as a target like any other.
        setBranches([{ slug: 'hq', name: 'HQ (Head Office)' }, ...list]);
        if (!branch) setBranch('hq');
      })
      .catch(() => showToast('Could not load the branch list', 'error'));
    // Naming the rule here broke the production build: the react-hooks plugin
    // is not registered in this project's ESLint config, so
    // "react-hooks/exhaustive-deps" is an unknown rule and the disable comment
    // itself becomes the error. Every other file uses the bare form.
    /* eslint-disable-next-line */
  }, []);

  const load = useCallback(async (slug) => {
    if (!slug) return;
    setLoading(true);
    try {
      const { data } = await getBranchPrices(slug);
      const list = data?.rows || [];
      setRows(list);
      const p = {};
      for (const r of list) p[r.sync_id] = num(r.branch_price);
      setPrices(p);
      setInitial({ ...p });
    } catch (e) {
      setRows([]); setPrices({}); setInitial({});
      showToast(e?.response?.data?.error || 'Could not load this branch', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(branch); setPushable([]); setPushTo([]); }, [branch, load]);

  const isHqView = branch === 'hq';
  const branchLabel = branches.find(b => b.slug === branch)?.name || branch;
  const depots = useMemo(() => branches.filter(b => b.slug !== 'hq' && b.slug !== branch), [branches, branch]);

  const dirty = useMemo(() => {
    const out = new Set();
    for (const r of rows) {
      if (Math.abs(num(prices[r.sync_id]) - num(initial[r.sync_id])) > 0.00001) out.add(r.sync_id);
    }
    return out;
  }, [rows, prices, initial]);

  const visible = useMemo(() => {
    let list = rows.filter(r => matchTokens(search, r.name, r.code));
    if (onlyDiff) list = list.filter(r => r.diff !== null && Math.abs(num(r.diff)) > 0.005);
    // 2026-09-21 — by name, A-Z. The list arrived in code order, and the codes
    // sort as text: RS0096 landed between RS009 and RS010, so the same drink
    // in two sizes could be pages apart and a price had to be hunted for.
    // Case is ignored, so "Mosi 375ml" and "MOSI CANNED" sit together.
    return [...list].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  }, [rows, search, onlyDiff]);

  const differing = useMemo(
    () => rows.filter(r => r.diff !== null && Math.abs(num(r.diff)) > 0.005).length, [rows]);

  const handleSave = async () => {
    if (dirty.size === 0) return;
    const branchName = branches.find(b => b.slug === branch)?.name || branch;
    const lines = rows.filter(r => dirty.has(r.sync_id)).slice(0, 12)
      .map(r => `  ${r.code}  ${r.name}   ${money(initial[r.sync_id])} → ${money(prices[r.sync_id])}`);
    const more = dirty.size > 12 ? `\n  …and ${dirty.size - 12} more` : '';
    if (!window.confirm(
      `Change ${dirty.size} price${dirty.size > 1 ? 's' : ''} at ${branchName}?\n\n${lines.join('\n')}${more}`
    )) return;

    setSaving(true);
    try {
      const updates = Array.from(dirty).map(sync_id => ({ sync_id, base_price: num(prices[sync_id]) }));
      const { data } = await saveBranchPrices(branch, updates);
      const skipped = (data?.skipped || []).length;
      // Keep what actually committed — this is what Multi Push may send on.
      // HQ ONLY. A price set at Mandevu is Mandevu's own decision; offering to
      // spread it across the other depots invites exactly the accident this
      // screen exists to prevent. Distribution starts at HQ or not at all.
      if (isHqView) {
        const byId = new Map(rows.map(r => [r.sync_id, r]));
        setPushable(updates.map(u => ({
          ...u,
          code: byId.get(u.sync_id)?.code || '',
          name: byId.get(u.sync_id)?.name || u.sync_id,
        })));
        setPushTo([]);
      }
      showToast(`${data?.updated ?? updates.length} price(s) updated at ${branchName}`
        + (skipped ? ` — ${skipped} skipped` : ''), skipped ? 'error' : 'success');
      await load(branch);
    } catch (e) {
      showToast(e?.response?.data?.error || e.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const doMultiPush = async () => {
    if (pushable.length === 0 || pushTo.length === 0) return;
    setPushing(true);
    try {
      const updates = pushable.map(p => ({ sync_id: p.sync_id, base_price: p.base_price }));
      const { data } = await multiPushBranchPrices(updates, pushTo);
      const failed = (data?.results || []).filter(r => r.error);
      showToast(
        `${data?.updated ?? 0} price(s) set across ${pushTo.length} depot${pushTo.length > 1 ? 's' : ''}`
        + (failed.length ? ` — ${failed.length} failed` : ''),
        failed.length ? 'error' : 'success');
      setPushOpen(false);
      setPushTo([]);
    } catch (e) {
      showToast(e?.response?.data?.error || e.message || 'Push failed', 'error');
    } finally {
      setPushing(false);
    }
  };

  const discard = () => {
    if (dirty.size === 0) return;
    if (!window.confirm(`Discard ${dirty.size} unsaved change(s)?`)) return;
    setPrices({ ...initial });
  };

  if (!hasPermission('Items:Edit') && !hasPermission('BranchPrices:Edit')) {
    return <div style={{ padding: 40 }}><h2>Access denied</h2><p>You don't have permission to change branch prices.</p></div>;
  }

  const th = { textAlign: 'left', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5,
               textTransform: 'uppercase', color: '#6b7280', padding: '10px 12px',
               borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
  const td = { padding: '8px 12px', borderBottom: '1px solid #f3f4f6', fontSize: 13.5 };

  return (
    <div className="page-content">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>Branch Prices</h1>
          <p>
            {isHqView
              ? 'Set HQ’s own selling price, then Multi Push it to the depots you choose.'
              : "Set the selling price for one branch. HQ's own price is shown beside it."}
            {dirty.size > 0 && <strong style={{ color: '#d97706' }}> {dirty.size} unsaved change{dirty.size > 1 ? 's' : ''}</strong>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {dirty.size > 0 && (
            <button onClick={discard} disabled={saving}
              style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <FiRefreshCw size={14} /> Discard
            </button>
          )}
          {/* 2026-09-04 — appears only once a save has committed something.
              Nothing typed and unsaved can ever be distributed. */}
          {isHqView && pushable.length > 0 && (
            <button onClick={() => setPushOpen(true)} disabled={saving}
              style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <FiUploadCloud size={15} /> Multi Push ({pushable.length})
            </button>
          )}
          <button onClick={handleSave} disabled={saving || dirty.size === 0}
            style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: dirty.size > 0 ? '#16a34a' : '#cbd5e1', color: '#fff', cursor: dirty.size > 0 ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <FiSave size={15} /> {saving ? 'Saving…' : `Save${dirty.size > 0 ? ` ${dirty.size} change${dirty.size > 1 ? 's' : ''}` : ''}`}
          </button>
        </div>
      </div>

      {/* Branch picker on top, the way Liquor does it. */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '14px 0 10px', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Branch</label>
        <select value={branch} onChange={e => setBranch(e.target.value)} disabled={saving}
          style={{ padding: '10px 12px', borderRadius: 10, border: '1.5px solid #e5e7eb', fontSize: 13.5, fontWeight: 600, background: '#fff', minWidth: 220 }}>
          {branches.length === 0 && <option value="">— no branches —</option>}
          {branches.map(b => <option key={b.slug} value={b.slug}>{b.name || b.business_name || b.slug}</option>)}
        </select>

        <div style={{ position: 'relative', flex: '0 0 320px' }}>
          <FiSearch style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} size={15} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or code…"
            style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 10, border: '1.5px solid #e5e7eb', fontSize: 13, background: '#fff', outline: 'none' }} />
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />
          Only prices that differ from HQ
        </label>

        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {visible.length} of {rows.length} · <strong>{differing}</strong> differ from HQ
        </div>
      </div>

      {/* 2026-09-02 — the warning that used to sit here named "Push Prices to
          All Branches" as the one thing that silently undid this work. That
          button is now hidden (SHOW_BULK_PUSH_PRICES in ItemDetails.js), so
          nothing overwrites this screen any more and the warning would only
          point at a control the user cannot find. Restore both together if the
          button ever comes back. */}

      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#94a3b8' }}>Loading prices…</div>
      ) : visible.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', background: '#fff', borderRadius: 12 }}>
          {rows.length === 0 ? 'This branch has no items.' : 'Nothing matches.'}
        </div>
      ) : (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                <th style={th}>Code</th>
                <th style={th}>Item</th>
                {/* 2026-09-04 — on HQ the two columns are the same book, so
                    "HQ" against "HQ" reads as a mistake. Existing / New Price
                    says what they actually are: what is stored, and what you
                    are typing over it. */}
                <th style={{ ...th, textAlign: 'right' }}>{isHqView ? 'Existing' : 'HQ'}</th>
                <th style={{ ...th, textAlign: 'right', width: 150 }}>
                  {isHqView ? 'NEW PRICE' : String(branchLabel || 'Branch').toUpperCase()}
                </th>
                <th style={{ ...th, textAlign: 'right' }}>Diff</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => {
                const isDirty = dirty.has(r.sync_id);
                const cur = num(prices[r.sync_id]);
                // On HQ, comparing against hq_price would always be zero — you
                // are editing that very figure. Compare against what the row
                // was loaded with, so Diff shows the change you are making.
                const hq  = isHqView
                  ? num(initial[r.sync_id])
                  : (r.hq_price === null ? null : num(r.hq_price));
                // Live difference against HQ, so it moves as you type rather
                // than showing the figure the row was loaded with.
                const d = hq === null ? null : cur - hq;
                const key = r.sync_id;
                return (
                  <tr key={key} style={{ background: isDirty ? '#fffbeb' : 'transparent' }}>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{r.code}</td>
                    <td style={{ ...td, fontWeight: 600, color: '#0f172a' }}>
                      {r.name}
                      {r.unit && <span style={{ color: '#94a3b8', fontWeight: 400, fontSize: 11.5 }}> / {r.unit}</span>}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#6b7280' }}>
                      {hq === null ? '—' : `${curSym}${money(hq)}`}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <input
                        type="text" inputMode="decimal"
                        value={editing === key ? editRaw : (cur === 0 ? '' : cur.toFixed(2))}
                        onFocus={() => { setEditing(key); setEditRaw(cur === 0 ? '' : cur.toFixed(2)); }}
                        onBlur={() => { setEditing(null); setEditRaw(''); }}
                        onChange={e => {
                          setEditing(key); setEditRaw(e.target.value);
                          setPrices(p => ({ ...p, [key]: num(e.target.value) }));
                        }}
                        onWheel={e => e.target.blur()}
                        placeholder="0.00"
                        style={{ width: 120, padding: '7px 10px', borderRadius: 8, textAlign: 'right',
                                 fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                                 border: `2px solid ${isDirty ? '#f59e0b' : '#e5e7eb'}`,
                                 background: isDirty ? '#fff' : '#fafafa', color: '#0f172a', outline: 'none' }} />
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                                 color: d === null ? '#94a3b8' : (Math.abs(d) < 0.005 ? '#94a3b8' : (d > 0 ? '#15803d' : '#b91c1c')) }}>
                      {d === null ? '—' : (Math.abs(d) < 0.005 ? '—' : `${d > 0 ? '+' : '−'}${money(Math.abs(d))}`)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Multi Push ─────────────────────────────────────────────────
          Every depot starts UNTICKED. The old bulk button went everywhere by
          default and that is precisely what made it dangerous; here the
          operator has to say where, every time, and the action is inert until
          they do. */}
      {pushOpen && isHqView && (
        <div onClick={() => !pushing && setPushOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9998, padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 620, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.25)' }}>

            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a' }}>
                  Push {pushable.length} price{pushable.length > 1 ? 's' : ''}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  Just saved at {branchLabel}. Choose where else they apply.
                </div>
              </div>
              <button onClick={() => setPushOpen(false)} disabled={pushing}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}>
                <FiX size={20} />
              </button>
            </div>

            <div style={{ padding: '14px 20px', overflowY: 'auto' }}>
              <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', marginBottom: 14, maxHeight: 132, overflowY: 'auto' }}>
                {pushable.map(p => (
                  <div key={p.sync_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0', color: '#334155' }}>
                    <span><span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>{p.code}</span> {p.name}</span>
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{curSym}{money(p.base_price)}</strong>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Depots</span>
                <span style={{ display: 'inline-flex', gap: 8 }}>
                  <button onClick={() => setPushTo(depots.map(d => d.slug))}
                    style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Select all</button>
                  <button onClick={() => setPushTo([])}
                    style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>None</button>
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
                {depots.map(d => {
                  const on = pushTo.includes(d.slug);
                  return (
                    <label key={d.slug}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                               border: `1.5px solid ${on ? '#2563eb' : '#e5e7eb'}`, background: on ? '#eff6ff' : '#fff', color: on ? '#1d4ed8' : '#334155' }}>
                      <input type="checkbox" checked={on}
                        onChange={e => setPushTo(prev => e.target.checked
                          ? [...prev, d.slug]
                          : prev.filter(x => x !== d.slug))} />
                      {d.name || d.slug}
                    </label>
                  );
                })}
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14, padding: '10px 12px', borderRadius: 9, background: '#fffbeb', border: '1px solid #fde68a' }}>
                <FiAlertTriangle size={15} style={{ color: '#b45309', flexShrink: 0, marginTop: 1 }} />
                <span style={{ fontSize: 12, color: '#92400e', lineHeight: 1.45 }}>
                  A depot with its own price for one of these items will be overwritten.
                  Leave it unticked to keep its local price.
                </span>
              </div>
            </div>

            <div style={{ padding: '14px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setPushOpen(false)} disabled={pushing}
                style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={doMultiPush} disabled={pushing || pushTo.length === 0}
                style={{ padding: '10px 20px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 700, color: '#fff',
                         display: 'inline-flex', alignItems: 'center', gap: 7,
                         background: pushTo.length > 0 ? '#2563eb' : '#cbd5e1',
                         cursor: pushTo.length > 0 ? 'pointer' : 'not-allowed' }}>
                <FiUploadCloud size={15} />
                {pushing ? 'Pushing…' : `Push to ${pushTo.length} depot${pushTo.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 20px', borderRadius: 10, background: toast.type === 'error' ? '#dc2626' : '#16a34a', color: '#fff', fontWeight: 600, fontSize: 13, boxShadow: '0 10px 24px rgba(0,0,0,0.15)', zIndex: 9999 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
};

export default BranchPrices;
