// PurchaseTrace — "where has this purchase got to?", asked the way Red Sea
// actually asks it: by the supplier's invoice number.
//
// 2026-09-04 — lives here rather than on one page because HQ Purchases and
// GRN Archive both need it, and the answer is the same answer. Whichever page
// you are standing on, the timeline is the purchase's, not the page's.
//
// Two separate jobs, deliberately kept apart:
//   - the SEARCH narrows the page — suggestions, and the table below it
//   - TRACK opens one purchase's history, and only when asked for
// Searching used to open a timeline by itself, which put a wall of history in
// front of anyone who only wanted to find a row. Track is a toggle: press it
// to see the history, press it again to put it away.
import React, { useEffect, useRef, useState } from 'react';
import { FiSearch, FiX, FiActivity } from 'react-icons/fi';
import { traceHqPurchase } from '../services/api';

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STAGE_META = {
  // 2026-09-09 — a draft is findable by its invoice number, so it needs to say
  // plainly that nothing has happened to it yet. Grey, so it cannot be mistaken
  // for a stage in the pipeline.
  DRAFT:    ['#e2e8f0', '#475569', 'Draft — not raised yet'],
  SENT:     ['#e0f2fe', '#075985', 'With the depot'],
  RECEIVED: ['#fef3c7', '#92400e', 'Counted — awaiting GRN'],
  GRN:      ['#ede9fe', '#5b21b6', 'GRN raised — awaiting Accounts'],
  CHECKED:  ['#dbeafe', '#1e40af', 'Checked — awaiting Finance'],
  APPROVED: ['#dcfce7', '#166534', 'Approved — awaiting payment'],
  PAID:     ['#d1fae5', '#065f46', 'Paid'],
};

function fmtWhen(v) {
  if (!v) return '';
  // Timestamps are stored as SQLite datetime('now') (UTC, space separator);
  // dates are plain YYYY-MM-DD. Only the first needs a timezone hint.
  const s = String(v);
  const iso = s.includes(' ') ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  return s.includes(' ')
    ? d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function usePurchaseTrace() {
  // -- the search: suggestions, and whatever the page filters by -----------
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);   // null = not searched yet
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);

  // -- the track: one purchase's history, opened on request ----------------
  const [trackTerm, setTrackTerm] = useState('');
  const [tracked, setTracked] = useState(null);
  const [tracking, setTracking] = useState(false);

  // Debounced so typing an invoice number is one query, not eight. Two
  // characters is the server's own floor.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults(null); setOpen(false); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      traceHqPurchase(term)
        .then(r => { const list = r.data?.results || []; setResults(list); setOpen(list.length > 0); })
        .catch(() => { setResults([]); setOpen(false); })
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // Track fetches on its own rather than reusing the suggestions: the row
  // being tracked is often outside them — the search caps at ten while the
  // table shows every match — and the history must not depend on what
  // happens to be typed in the box.
  const reqId = useRef(0);
  useEffect(() => {
    const term = trackTerm.trim();
    if (!term) { setTracked(null); setTracking(false); return; }
    const mine = ++reqId.current;
    setTracking(true);
    traceHqPurchase(term)
      .then(r => { if (mine === reqId.current) setTracked((r.data?.results || [])[0] || null); })
      .catch(() => { if (mine === reqId.current) setTracked(null); })
      .finally(() => { if (mine === reqId.current) setTracking(false); });
  }, [trackTerm]);

  return {
    q, setQ, results, open, setOpen, searching,
    trackTerm, tracked, tracking,
    // A toggle: the same button opens and closes a purchase's history.
    track: (term) => setTrackTerm(cur => (cur === String(term) ? '' : String(term || ''))),
    untrack: () => setTrackTerm(''),
    isTracking: (term) => !!term && trackTerm === String(term),
    // The X on the search box puts everything away, history included.
    clear: () => { setQ(''); setResults(null); setOpen(false); setTrackTerm(''); },
  };
}

// A row's Track button. Takes whichever reference that row actually holds.
export function TrackButton({ trace, term, title }) {
  if (!term) return null;
  const on = trace.isTracking(term);
  return (
    <button
      onClick={() => {
        trace.track(term);
        // The panel sits at the top of the page; a row 40 deep would otherwise
        // open something the user cannot see. Only on the way in — scrolling
        // up to close something is pointless.
        if (!on) { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { /* older browsers */ } }
      }}
      title={title || (on ? `Hide the history for ${term}` : `Track ${term}`)}
      style={{
        padding: '5px 10px',
        background: on ? '#7c3aed' : '#fff',
        color: on ? '#fff' : '#7c3aed',
        border: `1px solid ${on ? '#7c3aed' : '#ddd6fe'}`,
        borderRadius: 4, cursor: 'pointer',
        fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4,
        whiteSpace: 'nowrap',
      }}>
      <FiActivity size={12} /> {on ? 'Hide' : 'Track'}
    </button>
  );
}

export function TraceSearchBox({ trace, style }) {
  const list = (trace.results || []).slice(0, 5);
  return (
    <div style={{ position: 'relative' }}>
      <FiSearch style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
      <input
        value={trace.q}
        onChange={e => trace.setQ(e.target.value)}
        onFocus={() => { if ((trace.results || []).length > 0) trace.setOpen(true); }}
        onBlur={() => setTimeout(() => trace.setOpen(false), 150)}
        placeholder="Search invoice #, PO or GRN"
        autoComplete="off"
        style={{ ...style, paddingLeft: 30, paddingRight: trace.q ? 28 : 10, minWidth: 250 }}
      />
      {trace.q && (
        <button onClick={trace.clear} title="Clear"
          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex' }}>
          <FiX />
        </button>
      )}

      {/* Up to five matches. A part-typed invoice number can hit several
          purchases and they are told apart by supplier and PO, not by the
          fragment that matched — so every suggestion names all of them.

          Picking one fills the box with that exact invoice number, which
          narrows the table to it. It does NOT open the history: finding a row
          and reading its history are two different jobs. */}
      {trace.open && list.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60,
          marginTop: 4, background: '#fff', border: '1px solid #e5e7eb',
          borderRadius: 10, boxShadow: '0 12px 28px rgba(0,0,0,0.14)', overflow: 'hidden',
          minWidth: 340,
        }}>
          {list.map(r => {
            const [bg, fg, text] = STAGE_META[r.stage] || ['#e2e8f0', '#0f172a', r.stage];
            const inv = r.invoice_received || r.invoice_on_grn || r.invoice_raised;
            return (
              <div key={r.purchase_sync_id}
                onMouseDown={() => { trace.setQ(inv || r.purchase_number); trace.setOpen(false); }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
                style={{
                  padding: '8px 11px', cursor: 'pointer', background: '#fff',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                  borderLeft: `3px solid ${fg}`,
                }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
                    {inv ? <span style={{ fontFamily: 'monospace' }}>{inv}</span>
                         : <span style={{ color: '#b45309' }}>no invoice #</span>}
                    <span style={{ fontWeight: 500, color: '#64748b' }}> · {r.supplier_name || 'Supplier —'}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
                    {r.purchase_number}{r.grn_number ? ` · ${r.grn_number}` : ''}
                  </div>
                </div>
                <span style={{
                  flexShrink: 0, background: bg, color: fg, fontSize: 10, fontWeight: 800,
                  padding: '2px 7px', borderRadius: 10, whiteSpace: 'nowrap',
                }}>{text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TraceResult({ r, onClose }) {
  const [bg, fg, text] = STAGE_META[r.stage] || ['#e2e8f0', '#0f172a', r.stage];
  // The three places an invoice number can live for one purchase. They should
  // agree; when they do not, that is worth the operator's attention, so the
  // disagreement is shown rather than resolved silently.
  const nums = [...new Set([r.invoice_received, r.invoice_on_grn, r.invoice_raised].filter(Boolean))];
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>
            {r.purchase_number}
            <span style={{ fontWeight: 500, color: '#64748b' }}> · {r.supplier_name || 'Supplier —'}</span>
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
            {nums.length === 0
              ? <span style={{ color: '#b45309' }}>No invoice number recorded yet</span>
              : <>Invoice <strong style={{ fontFamily: 'monospace', color: '#0f172a' }}>{nums[0]}</strong>
                  {nums.length > 1 && (
                    <span style={{ color: '#b45309' }}> · also recorded as {nums.slice(1).join(', ')}</span>
                  )}</>}
            {r.destination ? ` · ${r.destination}` : ''}
            {` · ${fmtMoney(r.total_amount)}`}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 12, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' }}>
            {text}
          </span>
          {/* Closable from the panel as well as from the row's button — the
              row that opened it may be scrolled far out of sight. */}
          <button onClick={onClose} title="Hide"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex', padding: 2 }}>
            <FiX size={18} />
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {r.steps.map((s, i) => {
          // A stage still owed is drawn hollow and greyed, and says what it is
          // waiting for. Stopping the list at the last completed stage made a
          // purchase parked in the Accounts queue read as finished.
          const dot = s.warn ? '#dc2626' : s.done ? '#16a34a' : '#fff';
          return (
            <div key={s.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <span style={{
                  width: 9, height: 9, borderRadius: '50%', marginTop: 5,
                  background: dot,
                  border: s.done || s.warn ? 'none' : '2px solid #cbd5e1',
                  boxSizing: 'border-box',
                }} />
                {i < r.steps.length - 1 && (
                  <span style={{
                    width: 2, flex: 1, minHeight: 18,
                    background: s.done ? '#e2e8f0' : '#f1f5f9',
                  }} />
                )}
              </div>
              <div style={{ paddingBottom: i < r.steps.length - 1 ? 8 : 0, fontSize: 12.5 }}>
                <span style={{ fontWeight: s.done ? 700 : 500, color: s.warn ? '#991b1b' : s.done ? '#0f172a' : '#94a3b8' }}>
                  {s.label}
                </span>
                <span style={{ color: s.done ? '#64748b' : '#b0bac6' }}>
                  {s.done
                    ? `${s.at ? ` · ${fmtWhen(s.at)}` : ''}${s.by ? ` · ${s.by}` : ''}${s.detail ? ` · ${s.detail}` : ''}`
                    : ' · pending'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Only ever shows what Track asked for. Searching does not open this.
export function TracePanel({ trace }) {
  if (!trace.trackTerm) return null;
  if (trace.tracking && !trace.tracked) {
    return <p style={{ color: '#64748b', margin: '0 0 14px' }}>Loading history for {trace.trackTerm}…</p>;
  }
  if (!trace.tracked) {
    return (
      <div style={{ marginBottom: 14, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '12px 14px', color: '#9a3412', fontSize: 13 }}>
        No purchase history found for “{trace.trackTerm}”.
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 14 }}>
      <TraceResult r={trace.tracked} onClose={trace.untrack} />
    </div>
  );
}
