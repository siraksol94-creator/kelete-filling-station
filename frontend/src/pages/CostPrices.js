// 2026-09-21 â€” Cost Price (C.P.), a tab on Item Details at HQ.
//
// C.P. is the OPENING cost: what an item was worth when the system started.
// It is not the weighted average, and nothing here writes one.
//
// Why it exists: cost_price is filled on 2 items out of 119 at every depot,
// because it was skipped when opening balances were loaded. The cost a report
// uses is avg_cost_price, then the average of that item's GRNs, and only then
// cost_price â€” so an item that has never been delivered to a depot has no cost
// at all and its sales read as 100% profit. Ninety-odd items per depot are in
// that state. Setting C.P. gives them a floor until a real delivery arrives,
// and from that moment the weighted average takes over by itself.
//
// Shaped like Branch Prices deliberately â€” the same people use both, and the
// muscle memory should carry: type, Save, then push only what changed, only to
// the depots ticked.
import React, { useEffect, useMemo, useState } from 'react';
import { getHqBranches, getCostPrices, saveCostPrices, pushCostPrices } from '../services/api';
import { useCurrency } from '../context/CurrencyContext';
import { FiSearch, FiSave, FiUploadCloud, FiX, FiAlertTriangle, FiRefreshCw } from 'react-icons/fi';
import { matchTokens } from '../utils/tokenSearch';
import { sortBranches, branchLabel } from '../utils/sortBranches';

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const money = (v) => num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// readOnly â€” the depot's view. Same list, no way to change it: the inputs
// become plain figures and Save and Sync are not rendered at all. The server
// refuses a depot's write regardless (routes/products.js), so this is the
// screen telling the truth about that, not the thing enforcing it.
const CostPrices = ({ readOnly = false }) => {
  const { symbol: curSym } = useCurrency();

  const [rows, setRows]       = useState([]);
  const [costs, setCosts]     = useState({});     // sync_id -> typed value
  const [initial, setInitial] = useState({});     // sync_id -> value as loaded
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [search, setSearch]   = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [toast, setToast]     = useState(null);

  const [depots, setDepots]   = useState([]);
  const [pushOpen, setPushOpen] = useState(false);
  const [pushTo, setPushTo]   = useState([]);
  const [pushing, setPushing] = useState(false);

  const say = (text, kind = 'ok') => {
    setToast({ text, kind });
    setTimeout(() => setToast(null), 3500);
  };

  const load = () => {
    setLoading(true);
    getCostPrices()
      .then(r => {
        const list = r.data?.rows || [];
        setRows(list);
        const c = {};
        for (const p of list) c[p.sync_id] = String(num(p.cost_price) || '');
        setCosts(c);
        setInitial({ ...c });
      })
      .catch(e => say(e.response?.data?.error || 'Could not load items.', 'err'))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    // The depot list is only ever used by the push modal, which a depot does
    // not get. Asking for it there would be a 403 for nothing.
    if (readOnly) return;
    getHqBranches()
      .then(r => setDepots(sortBranches((r.data?.branches || [])
        .filter(b => b.slug && !/^(hq|kelete|keletedistributionzm|www)$/i.test(b.slug)))))
      .catch(() => setDepots([]));
  // eslint-disable-next-line
  }, []);

  const dirty = useMemo(() => {
    const s = new Set();
    for (const r of rows) {
      if (Math.abs(num(costs[r.sync_id]) - num(initial[r.sync_id])) > 0.00001) s.add(r.sync_id);
    }
    return s;
  }, [rows, costs, initial]);

  const visible = useMemo(() => {
    let list = rows.filter(r => matchTokens(search, r.name, r.code));
    if (onlyMissing) list = list.filter(r => num(costs[r.sync_id]) <= 0);
    return [...list].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  }, [rows, costs, search, onlyMissing]);

  const missing = useMemo(
    () => rows.filter(r => num(costs[r.sync_id]) <= 0).length, [rows, costs]);

  const changedUpdates = () => Array.from(dirty)
    .map(sync_id => ({ sync_id, cost_price: num(costs[sync_id]) }));

  const handleSave = async () => {
    if (dirty.size === 0) return;
    setSaving(true);
    try {
      await saveCostPrices(changedUpdates());
      setInitial({ ...costs });
      say(`Saved ${dirty.size} cost${dirty.size === 1 ? '' : 's'} at HQ. Push them to the depots next.`);
    } catch (e) {
      say(e.response?.data?.error || 'Could not save.', 'err');
    }
    setSaving(false);
  };

  // What gets pushed: everything with a cost, not only what was just typed.
  // The point of the screen is to give depots a cost they do not have, and a
  // figure saved last week is as useful as one saved a minute ago.
  const pushable = useMemo(
    () => rows.filter(r => num(costs[r.sync_id]) > 0)
      .map(r => ({ sync_id: r.sync_id, code: r.code, name: r.name, cost_price: num(costs[r.sync_id]) })),
    [rows, costs]);

  const doPush = async () => {
    if (pushTo.length === 0) return say('Pick at least one depot.', 'err');
    setPushing(true);
    try {
      const r = await pushCostPrices(pushable.map(p => ({ sync_id: p.sync_id, cost_price: p.cost_price })), pushTo);
      const d = r.data || {};
      say(`Sent ${d.items} cost${d.items === 1 ? '' : 's'} to ${d.depots} depot${d.depots === 1 ? '' : 's'} â€” ${d.updated} item${d.updated === 1 ? '' : 's'} updated.`);
      setPushOpen(false);
      setPushTo([]);
    } catch (e) {
      say(e.response?.data?.error || 'Push failed.', 'err');
    }
    setPushing(false);
  };

  const th = { padding: '10px 12px', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 };
  const td = { padding: '8px 12px', fontSize: 13, color: '#0f172a' };
  const inp = { width: 110, padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, textAlign: 'right' };

  return (
    <div style={{ padding: '0 0 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#0f172a' }}>Cost Price (C.P.)</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            {readOnly
              ? 'What each item cost when the system started. Set at HQ â€” this branch can see it, not change it.'
              : 'What each item cost when the system started. Set it here, then send it to the depots you choose.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 14px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <FiRefreshCw size={14} /> Reload
          </button>
          {!readOnly && <button onClick={handleSave} disabled={saving || dirty.size === 0}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: dirty.size ? '#C8102E' : '#e5e7eb', color: dirty.size ? '#fff' : '#9ca3af', border: 'none', borderRadius: 8, cursor: dirty.size ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700 }}>
            <FiSave size={14} /> {saving ? 'Savingâ€¦' : `Save${dirty.size ? ` (${dirty.size})` : ''}`}
          </button>}
          {!readOnly && <button onClick={() => setPushOpen(true)} disabled={pushable.length === 0}
            title={pushable.length === 0 ? 'Set at least one cost first' : 'Send these costs to depots'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: pushable.length ? '#0f172a' : '#e5e7eb', color: pushable.length ? '#fff' : '#9ca3af', border: 'none', borderRadius: 8, cursor: pushable.length ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700 }}>
            <FiUploadCloud size={14} /> Sync C.P. to depots
          </button>}
        </div>
      </div>

      {!readOnly && dirty.size > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, marginBottom: 12 }}>
          <FiAlertTriangle size={14} /> Saving stores the cost at HQ only. The depots keep theirs until you push.
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 380 }}>
          <FiSearch size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#94a3b8' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or codeâ€¦"
            style={{ width: '100%', padding: '8px 10px 8px 30px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#334155', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} />
          Only items with no C.P.
        </label>
        <div style={{ fontSize: 12.5, color: '#64748b' }}>
          {visible.length} of {rows.length} Â· <strong>{missing}</strong> with no cost
        </div>
      </div>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ background: '#f8fafc' }}>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Code</th>
              <th style={{ ...th, textAlign: 'left' }}>Item</th>
              <th style={{ ...th, textAlign: 'right' }}>C.P.</th>
              <th style={{ ...th, textAlign: 'right' }}>Weighted average</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: '#94a3b8' }}>Loadingâ€¦</td></tr>}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: '#94a3b8' }}>
                {rows.length === 0 ? 'No items.' : 'Nothing matches.'}
              </td></tr>
            )}
            {!loading && visible.map(r => {
              const wac = num(r.avg_cost_price);
              const changed = dirty.has(r.sync_id);
              return (
                <tr key={r.sync_id} style={{ borderTop: '1px solid #f1f5f9', background: changed ? '#fffbeb' : '#fff' }}>
                  <td style={{ ...td, color: '#64748b', fontSize: 12 }}>{r.code}</td>
                  <td style={td}>
                    {r.name} <span style={{ color: '#94a3b8', fontSize: 11 }}>/ {r.unit}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {readOnly
                      ? (num(costs[r.sync_id]) > 0
                          ? <span style={{ fontWeight: 600 }}>{curSym}{money(costs[r.sync_id])}</span>
                          // An item with no C.P. is the thing worth seeing on
                          // this screen, so it is named rather than left blank.
                          : <span style={{ color: '#cbd5e1' }}>not set</span>)
                      : <input type="number" step="0.01" min="0" value={costs[r.sync_id] ?? ''}
                          onChange={e => setCosts(c => ({ ...c, [r.sync_id]: e.target.value }))}
                          style={{ ...inp, borderColor: changed ? '#C8102E' : '#d1d5db' }} />}
                  </td>
                  {/* Shown so it is obvious when a real delivery has already
                      set a cost â€” from then on C.P. is not what reports use. */}
                  <td style={{ ...td, textAlign: 'right', color: wac > 0 ? '#166534' : '#cbd5e1' }}>
                    {wac > 0 ? `${curSym}${money(wac)}` : 'â€”'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pushOpen && (
        <div onClick={() => setPushOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, width: 'min(520px, 100%)', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Send {pushable.length} cost{pushable.length === 1 ? '' : 's'} toâ€¦</h3>
              <button onClick={() => setPushOpen(false)} style={{ background: 'none', border: 'none', fontSize: 22, color: '#64748b', cursor: 'pointer' }}>Ã—</button>
            </div>
            <div style={{ padding: 16, overflowY: 'auto' }}>
              <div style={{ fontSize: 12.5, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '9px 12px', marginBottom: 12 }}>
                This replaces each depot's own C.P. for these items. Items already delivered there keep using their
                weighted average, so their reports do not change.
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button onClick={() => setPushTo(depots.map(d => d.slug))}
                  style={{ padding: '6px 12px', fontSize: 12.5, borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>Select all</button>
                <button onClick={() => setPushTo([])}
                  style={{ padding: '6px 12px', fontSize: 12.5, borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>Clear</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                {depots.map(d => {
                  const on = pushTo.includes(d.slug);
                  return (
                    <label key={d.slug}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px', border: `1px solid ${on ? '#C8102E' : '#e5e7eb'}`, background: on ? '#fef2f2' : '#fff', borderRadius: 9, cursor: 'pointer', fontSize: 13 }}>
                      <input type="checkbox" checked={on}
                        onChange={() => setPushTo(s => on ? s.filter(x => x !== d.slug) : [...s, d.slug])} />
                      {branchLabel(d)}
                    </label>
                  );
                })}
              </div>
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setPushOpen(false)}
                style={{ padding: '10px 16px', borderRadius: 9, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Cancel</button>
              <button onClick={doPush} disabled={pushing || pushTo.length === 0}
                style={{ padding: '10px 18px', borderRadius: 9, border: 'none', background: pushTo.length ? '#0f172a' : '#e5e7eb', color: pushTo.length ? '#fff' : '#9ca3af', cursor: pushTo.length ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700 }}>
                {pushing ? 'Sendingâ€¦' : `Send to ${pushTo.length || 'no'} depot${pushTo.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 600, maxWidth: 380,
                      background: toast.kind === 'err' ? '#fef2f2' : '#f0fdf4',
                      border: `1px solid ${toast.kind === 'err' ? '#fecaca' : '#bbf7d0'}`,
                      color: toast.kind === 'err' ? '#991b1b' : '#166534',
                      borderRadius: 10, padding: '11px 14px', fontSize: 13, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <span style={{ flex: 1 }}>{toast.text}</span>
          <button onClick={() => setToast(null)} style={{ background: 'none', border: 0, cursor: 'pointer', color: 'inherit' }}><FiX size={15} /></button>
        </div>
      )}
    </div>
  );
};

export default CostPrices;
