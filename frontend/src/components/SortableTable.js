// SortableTable — click-to-sort table headers.
//
// 2026-09-04 — HQ Purchases and GRN Archive both list hundreds of rows in one
// fixed order, so finding a supplier's invoice meant scrolling. Both now share
// one sort, rather than each page growing its own slightly different version.
//
// Sorting is client-side and deliberately so: both lists are already capped
// server-side (500 rows), the whole page is in memory, and a round trip per
// column click would be slower than the sort itself.
import React, { useMemo, useRef, useState } from 'react';

// Numbers compare as numbers, dates and document numbers as text. A blank is
// always last regardless of direction — an empty invoice number is missing
// information, not a value that sorts before "A70426".
function compare(a, b) {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const an = parseFloat(a), bn = parseFloat(b);
  if (!isNaN(an) && !isNaN(bn) && String(a).trim() !== '' && String(b).trim() !== ''
      && String(an) === String(a).trim() && String(bn) === String(b).trim()) {
    return an - bn;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// rows: the array to sort. defaultKey/defaultDir: initial state.
// Each sortable column supplies a `get` function, so a column that renders
// something composite (a badge, two fields) still sorts on one clear value.
//
// tieBreak: an optional comparator for rows the sorted column cannot separate.
// It runs in its own fixed direction, never flipped by the header arrow — a
// date column ties for every purchase raised on the same day, and "newest
// entered first" within that day is right whichever way the dates run.
export function useSort(rows, defaultKey = null, defaultDir = 'desc', tieBreak = null) {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);
  const [getters] = useState(() => ({ current: {} }));
  // Held in a ref so an inline arrow function at the call site does not make
  // the memo recompute on every render.
  const tie = useRef(tieBreak);
  tie.current = tieBreak;

  const registerGetter = (key, get) => { getters.current[key] = get; };

  const toggle = (key) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const get = getters.current[sortKey] || ((r) => r[sortKey]);
    // 2026-09-09 — descending used to sort ascending and then reverse() the
    // whole array. reverse() does not spare equal elements, so every group of
    // rows the column could not separate came out backwards: six purchases all
    // dated the same day listed oldest first, putting the one just raised in
    // the middle of the page. The direction is applied to the comparator
    // instead, which leaves ties alone for the tie-break to settle.
    const sign = sortDir === 'desc' ? -1 : 1;
    // Copy first: Array.prototype.sort mutates, and these arrays come straight
    // from state.
    return [...rows].sort((x, y) => {
      const c = compare(get(x), get(y));
      if (c !== 0) return sign * c;
      return tie.current ? tie.current(x, y) : 0;
    });
    // `getters` is a useState value and `tie` is a ref, so neither changes
    // identity and both are deliberately not dependencies.
  }, [rows, sortKey, sortDir, getters]);

  return { sorted, sortKey, sortDir, toggle, registerGetter };
}

// A <th> that sorts. `sort` is the object returned by useSort.
export function SortTh({ sort, k, get, style, children, align }) {
  if (get) sort.registerGetter(k, get);
  const active = sort.sortKey === k;
  return (
    <th
      onClick={() => sort.toggle(k)}
      title="Sort by this column"
      style={{
        ...style,
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        textAlign: align || (style && style.textAlign) || 'left',
        color: active ? '#0f172a' : undefined,
      }}
    >
      {children}
      {/* The inactive arrow stays in the layout at low opacity so the header
          row does not shift by a few pixels every time a column is clicked. */}
      <span style={{ marginLeft: 4, opacity: active ? 1 : 0.25, fontSize: 10 }}>
        {active ? (sort.sortDir === 'asc' ? '▲' : '▼') : '▲'}
      </span>
    </th>
  );
}
