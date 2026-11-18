// ItemPicker — type-to-search product picker.
//
// 2026-08-30. Replaces <select> and <datalist> on the item lines.
//
// A plain <select> means scrolling a few hundred options. A <datalist> filters,
// but the browser matches your text as ONE continuous piece, so "car bl 500"
// finds nothing — the pieces are out of order. This uses matchTokens, the same
// helper behind every other search box in the app, so each space-separated
// piece only has to appear SOMEWHERE:
//
//     car bl 500  ->  CARLING BLACK LABEL 500ml CAN
//     bl 75       ->  BLACK LABEL 750mls   and   Black Label 375ml
//
// THE SAFETY RULE, carried over from v1.9.0 of HQ Purchases: typing is a way
// to FIND an item, never to invent one. Free text there once let strings like
// "fdfdfdf" become purchases and auto-create ghost branch products. Nothing is
// selected unless it was chosen from the list.
//
// Three things learned from the first version, in use:
//
//   1. The list is rendered through a PORTAL. Sitting inside the table cell it
//      was clipped by the table and the modal, so only the first result was
//      visible and sliced in half.
//   2. Once picked, the box shows the product NAME ONLY and goes read-only
//      with a clear button. It used to keep "Black Label 375ml (RS001)" — the
//      code is there to help you search, it is not part of the item's name —
//      and a single accidental keystroke silently unlinked the product.
//   3. The code still shows in the dropdown rows, so typing a code still finds
//      the item.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { matchTokens } from '../utils/tokenSearch';

// Enough to scroll, few enough to stay fast on a long catalogue.
const MAX_SHOWN = 60;

export default function ItemPicker({
  products = [],
  text = '',
  selected = false,        // does the parent currently hold a real product?
  onPick,                  // (product, name) => void
  onText,                  // (text) => void — typed, nothing resolved
  onClear,                 // () => void — user wants to choose again
  placeholder = 'Type to search items…',
  style = {},
  disabled = false,
  autoFocus = false,
  // Optional (2026-09-11). Returns a short label for items that belong at the
  // top — the Credit Note uses it for the lines on the chosen invoice
  // ("on invoice · 24"). Those rows are drawn green under a heading and the
  // rest follow under "Other items". The caller puts them first in
  // `products`; without tagFor the list looks exactly as before.
  tagFor = null,
  tagHeading = 'On this invoice',
  otherHeading = 'Other items',
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi]     = useState(0);
  const [rect, setRect] = useState(null);
  const boxRef   = useRef(null);
  const inputRef = useRef(null);
  const listRef  = useRef(null);

  const matches = useMemo(() => {
    if (selected) return [];
    const list = text
      ? products.filter(p => matchTokens(text, p.name, p.code, p.barcode))
      : products;                       // nothing typed: still a plain picker
    return list.slice(0, MAX_SHOWN);
  }, [products, text, selected]);

  // Measure the input so the portalled list can sit right under it. Re-measured
  // on scroll and resize, since the list is no longer a child of the input.
  const measure = () => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setRect({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 260) });
  };
  useLayoutEffect(() => { if (open) measure(); }, [open, text]);
  useEffect(() => {
    if (!open) return;
    const on = () => measure();
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on, true);
      window.removeEventListener('resize', on);
    };
  }, [open]);

  // Close when the click lands outside both the input and the portalled list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      const inBox  = boxRef.current  && boxRef.current.contains(e.target);
      const inList = listRef.current && listRef.current.contains(e.target);
      if (!inBox && !inList) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open || !listRef.current) return;
    // By data-idx, not children[hi]: section headings are children too.
    const el = listRef.current.querySelector(`[data-idx="${hi}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const choose = (p) => {
    if (!p) return;
    onPick && onPick(p, p.name);   // NAME only — the code was a search aid
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); setHi(0); return; }
      setHi(h => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && matches[hi]) { e.preventDefault(); choose(matches[hi]); }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const unresolved = !!text && !selected;

  // ── Picked: read-only, name only, with a way back ────────────────────────
  if (selected) {
    return (
      <div ref={boxRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="text"
          value={text}
          readOnly
          title={text}
          style={{ ...style, background: '#f8fafc', color: '#111827', cursor: 'default' }}
        />
        {!disabled && (
          <button
            type="button"
            onClick={() => { onClear && onClear(); setOpen(true); setTimeout(() => inputRef.current && inputRef.current.focus(), 0); }}
            title="Choose a different item"
            style={{
              flexShrink: 0, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280',
              borderRadius: 4, width: 22, height: 22, lineHeight: '18px', cursor: 'pointer',
              fontSize: 14, padding: 0,
            }}>
            ×
          </button>
        )}
      </div>
    );
  }

  // ── Searching ────────────────────────────────────────────────────────────
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="text"
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={e => { onText && onText(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => { setOpen(true); measure(); }}
        onKeyDown={onKeyDown}
        style={{
          ...style,
          border: unresolved ? '1px solid #f59e0b' : (style.border || '1px solid #d1d5db'),
          background: unresolved ? '#fffbeb' : (style.background || '#fff'),
        }}
      />
      {open && rect && ReactDOM.createPortal(
        matches.length > 0 ? (
          <div
            ref={listRef}
            style={{
              position: 'fixed', zIndex: 100000,
              top: rect.top, left: rect.left, width: rect.width,
              maxHeight: 280, overflowY: 'auto', background: '#fff',
              border: '1px solid #d1d5db', borderRadius: 6,
              boxShadow: '0 10px 28px rgba(0,0,0,0.16)',
            }}>
            {matches.map((p, idx) => {
              const tag = tagFor ? tagFor(p) : null;
              const prevTag = tagFor && idx > 0 ? tagFor(matches[idx - 1]) : null;
              // Tagged rows come first, so a heading goes on the first tagged
              // row and on the first untagged row after them.
              const heading = !tagFor ? null
                : (idx === 0 && tag) ? tagHeading
                : (!tag && prevTag) ? otherHeading
                : null;
              return (
                <React.Fragment key={p.sync_id || p.id}>
                  {heading && (
                    <div style={{
                      padding: '5px 10px', fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                      textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb',
                      color: tag ? '#15803d' : '#6b7280', background: tag ? '#f0fdf4' : '#f9fafb',
                    }}>
                      {heading}
                    </div>
                  )}
                  <div
                    data-idx={idx}
                    // onMouseDown, not onClick: mousedown fires before the input's
                    // blur, so the option is still there to be chosen.
                    onMouseDown={e => { e.preventDefault(); choose(p); }}
                    onMouseEnter={() => setHi(idx)}
                    style={{
                      padding: '8px 10px', fontSize: 12, cursor: 'pointer',
                      background: idx === hi ? (tag ? '#dcfce7' : '#eff6ff') : (tag ? '#f0fdf4' : '#fff'),
                      borderBottom: '1px solid #f8fafc',
                      ...(tagFor ? { borderLeft: `3px solid ${tag ? '#16a34a' : 'transparent'}` } : {}),
                      display: 'flex', justifyContent: 'space-between', gap: 10,
                    }}>
                    <span style={{ color: tag ? '#15803d' : '#111827', fontWeight: tag ? 600 : 400 }}>{p.name}</span>
                    {tag
                      ? <span style={{ color: '#16a34a', fontSize: 11, whiteSpace: 'nowrap' }}>{tag}</span>
                      : p.code && <span style={{ color: '#9ca3af', fontFamily: 'monospace', fontSize: 11 }}>{p.code}</span>}
                  </div>
                </React.Fragment>
              );
            })}
            {products.length > matches.length && (
              <div style={{ padding: '6px 10px', fontSize: 10, color: '#9ca3af', background: '#f9fafb' }}>
                Showing {matches.length} — keep typing to narrow down.
              </div>
            )}
          </div>
        ) : (text ? (
          <div
            ref={listRef}
            style={{
              position: 'fixed', zIndex: 100000,
              top: rect.top, left: rect.left, width: rect.width,
              background: '#fff', border: '1px solid #d1d5db', borderRadius: 6,
              padding: '8px 10px', fontSize: 11, color: '#b45309',
              boxShadow: '0 10px 28px rgba(0,0,0,0.16)',
            }}>
            No item matches “{text}”.
          </div>
        ) : null),
        document.body
      )}
    </div>
  );
}
