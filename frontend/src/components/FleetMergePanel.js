// F3 — "Merge into Customers" review for Administrators (decision 2026-11-18).
// Shows what the merge would do (matches, new customers, doubtful cases with
// a chooser, balances to carry) before anything changes; Apply runs it;
// Undo reverses the logged merges. Server: routes/fleetCustomers.js /merge/*.
import React, { useState } from 'react';
import { FiGitMerge, FiRotateCcw } from 'react-icons/fi';
import { getFleetMergePlan, applyFleetMerge, undoFleetMerge, getFleetMergeLog } from '../services/fuelApi';
import { S } from '../pages/fuelStyles';

const k = (n) => `${(Number(n || 0) < 0 ? '−' : '')}K${Math.abs(Number(n || 0)).toFixed(2)}`;

export default function FleetMergePanel({ onDone }) {
  const [plan, setPlan] = useState(null);
  const [log, setLog] = useState([]);
  const [resolve, setResolve] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const review = async () => {
    setBusy(true); setMsg('');
    try {
      const [p, l] = await Promise.all([getFleetMergePlan(), getFleetMergeLog()]);
      setPlan(p.data); setLog(l.data || []); setResolve({});
    } catch (e) { setMsg(e.response?.data?.error || 'Could not load the merge review'); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!window.confirm(`Merge ${plan.summary.to_merge + Object.keys(resolve).length} fleet account(s) into Customers and carry ${k(plan.summary.balance_to_carry)} of balances into Accounts Receivable?`)) return;
    setBusy(true); setMsg('');
    try {
      const r = (await applyFleetMerge(resolve)).data;
      setMsg(`Merged ${r.merged.length} account(s).${r.skipped.length ? ` ${r.skipped.length} left for a decision.` : ''}`);
      await review(); if (onDone) onDone();
    } catch (e) { setMsg(e.response?.data?.error || 'Merge failed'); }
    finally { setBusy(false); }
  };

  const undo = async (logId) => {
    if (!window.confirm(logId ? 'Undo this merge?' : 'Undo ALL merges that are still in place?')) return;
    setBusy(true); setMsg('');
    try {
      const r = (await undoFleetMerge(logId)).data;
      setMsg(`Undone: ${r.undone.length}.`);
      await review(); if (onDone) onDone();
    } catch (e) { setMsg(e.response?.data?.error || 'Undo failed'); }
    finally { setBusy(false); }
  };

  const row = (cells, key) => <tr key={key} style={{ borderBottom: '1px solid #f1f5f9' }}>{cells.map((c, i) => <td key={i} style={S.td}>{c}</td>)}</tr>;

  return (
    <div style={{ ...S.card, marginBottom: 16, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <strong><FiGitMerge /> Merge into Customers</strong>
          <div style={{ fontSize: 13, color: '#64748b' }}>One accounts-receivable list: each fleet account is matched to a Customer by phone or name, or a new Credit customer is created; its balance moves to that Customer.</div>
        </div>
        <button onClick={review} disabled={busy} style={S.btnSecondary}>{plan ? 'Refresh review' : 'Review merge'}</button>
      </div>
      {msg && <div style={{ marginTop: 10, fontSize: 14 }}>{msg}</div>}

      {plan && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>
            To merge: <strong>{plan.summary.to_merge}</strong> ({plan.summary.matched} matched, {plan.summary.create} new) ·
            needing a decision: <strong>{plan.summary.ambiguous}</strong> · balances to carry: <strong>{k(plan.summary.balance_to_carry)}</strong> ·
            already merged: {plan.already_merged}
          </div>
          <table style={S.table}>
            <thead><tr><th style={S.th}>Fleet account</th><th style={S.th}>Balance</th><th style={S.th}>Old tickets</th><th style={S.th}>Becomes</th></tr></thead>
            <tbody>
              {plan.matched.map(m => row([`${m.name}${m.phone ? ` · ${m.phone}` : ''}`, k(m.balance), m.tickets,
                <span>Customer <strong>{m.customer.name}</strong> <span style={S.pill('#16a34a')}>by {m.by}</span></span>], `m${m.fleet_id}`))}
              {plan.create.map(c => row([`${c.name}${c.phone ? ` · ${c.phone}` : ''}`, k(c.balance), c.tickets,
                <span style={S.pill('#2563eb')}>new Credit customer</span>], `c${c.fleet_id}`))}
              {plan.ambiguous.map(a => row([`${a.name}${a.phone ? ` · ${a.phone}` : ''}`, k(a.balance), a.tickets,
                <select value={resolve[a.fleet_id] || ''} onChange={e => setResolve({ ...resolve, [a.fleet_id]: e.target.value || undefined })}>
                  <option value="">— choose (left out until chosen) —</option>
                  {a.candidates.map(c => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''} (same {c.by})</option>)}
                  <option value="new">Create a new customer</option>
                </select>], `a${a.fleet_id}`))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
            <button onClick={apply} disabled={busy || (plan.summary.to_merge === 0 && !Object.values(resolve).some(Boolean))} style={S.btnPrimary}><FiGitMerge /> Apply merge</button>
            {log.some(l => !l.undone_at) && <button onClick={() => undo(null)} disabled={busy} style={S.btnSecondary}><FiRotateCcw /> Undo all merges</button>}
          </div>
          {log.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#334155' }}>
              <strong>Merge log</strong>
              {log.slice(0, 20).map(l => (
                <div key={l.id}>
                  #{l.id} {l.fleet_name} → {l.customer_name} ({l.matched_by}{l.created_customer ? ', created' : ''}) · carried {k(l.balance_carried)} · {l.merged_at}
                  {l.undone_at ? ` · undone ${l.undone_at}` : <button onClick={() => undo(l.id)} disabled={busy} style={{ marginLeft: 8, ...S.btnSecondary, padding: '2px 8px' }}>Undo</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
