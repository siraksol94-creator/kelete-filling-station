// UX-6 — "Find a screen" at the top of the side menu, plus keyboard use of
// the whole menu. It filters the menu that is already drawn, so permissions
// stay exactly as Layout decides them: a screen you can't open is never in
// the menu, so it can never be found either.
//   Type to filter (all groups open while searching) · ↓ moves into the
//   results · Enter opens the first match · Esc clears · Ctrl+K from anywhere.
import React, { useEffect, useRef, useState } from 'react';
import { FiSearch, FiX, FiClock } from 'react-icons/fi';
import { matches } from './navModel';

const FOCUSABLE = '.nav-item, .nav-group-header';
const visible = (el) => el && !el.classList.contains('k-nav-miss') && el.offsetParent !== null;
const labelOf = (el) => {
  const s = el.querySelector('span');
  return (s ? s.textContent : el.textContent || '').trim();
};

// Applies the filter to the drawn menu; returns how many screens match.
function applyFilter(nav, query) {
  if (!nav) return 0;
  let hits = 0;
  nav.querySelectorAll('.k-nav-first').forEach((el) => el.classList.remove('k-nav-first'));
  nav.querySelectorAll('.nav-item').forEach((item) => {
    const kids = item.closest('.nav-children');
    const header = kids && kids.previousElementSibling && kids.previousElementSibling.classList.contains('nav-group-header') ? kids.previousElementSibling : null;
    const ok = matches(labelOf(item), header ? labelOf(header) : '', query);
    item.classList.toggle('k-nav-miss', !ok);
    if (ok && query) { if (hits === 0) item.classList.add('k-nav-first'); hits += 1; }
  });
  nav.querySelectorAll('.nav-group-header').forEach((h) => {
    const kids = h.nextElementSibling && h.nextElementSibling.classList.contains('nav-children') ? h.nextElementSibling : null;
    const any = kids ? [...kids.querySelectorAll('.nav-item')].some((i) => !i.classList.contains('k-nav-miss')) : false;
    h.classList.toggle('k-nav-miss', !!query && !any);
    if (kids) kids.classList.toggle('k-nav-miss', !!query && !any);
  });
  return hits;
}

// Keyboard and screen-reader support for the menu's clickable rows.
export function useMenuKeyboard(navRef, deps) {
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    nav.querySelectorAll(FOCUSABLE).forEach((el) => {
      if (el.getAttribute('tabindex') == null) el.setAttribute('tabindex', '0');
      if (el.classList.contains('nav-group-header')) {
        el.setAttribute('role', 'button');
        const chev = el.querySelector('.chevron');
        el.setAttribute('aria-expanded', chev && chev.classList.contains('open') ? 'true' : 'false');
      } else {
        el.setAttribute('role', 'link');
        if (el.classList.contains('active')) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
      }
      // Collapsed menu: the icon alone needs a name.
      const name = el.getAttribute('data-k-label') || labelOf(el);
      if (name && !el.getAttribute('aria-label') && !el.querySelector('span')) el.setAttribute('aria-label', name);
    });
  }); // every render: rows come and go as groups open
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const onKey = (e) => {
      const el = e.target.closest && e.target.closest(FOCUSABLE);
      if (!el || !nav.contains(el)) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        // While searching, the arrows move between screens only (headings are just labels).
        const all = [...nav.querySelectorAll(nav.classList.contains('is-searching') ? '.nav-item' : FOCUSABLE)].filter(visible);
        const i = all.indexOf(el);
        const next = e.key === 'Home' ? all[0] : e.key === 'End' ? all[all.length - 1]
          : all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) { e.preventDefault(); next.focus(); }
      }
    };
    nav.addEventListener('keydown', onKey);
    return () => nav.removeEventListener('keydown', onKey);
  }, deps); // eslint-disable-line
}

export default function MenuFinder({ navRef, onSearching, recent = [], onOpenRecent, currentPath }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const inputRef = useRef(null);
  const searching = q.trim().length > 0;

  useEffect(() => { onSearching(searching); }, [searching]); // eslint-disable-line
  // Opening a screen (by click, keyboard or a link) ends the search.
  useEffect(() => { setQ(''); }, [currentPath]);
  // Leaving (menu collapsed to icons): put every row back.
  useEffect(() => () => { if (navRef.current) applyFilter(navRef.current, ''); onSearching(false); }, []); // eslint-disable-line
  // Re-filter after every render while searching (groups open, rows appear).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    if (searching) setHits(applyFilter(nav, q));
    else if (nav.querySelector('.k-nav-miss, .k-nav-first')) { applyFilter(nav, ''); setHits(null); }
  });
  // Ctrl+K (or ⌘K) from anywhere jumps to the finder.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('kelete:menu-open'));
        setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onKey = (e) => {
    const nav = navRef.current;
    if (e.key === 'Escape') { if (q) { e.stopPropagation(); setQ(''); } return; }
    if (!nav) return;
    if (e.key === 'Enter') {
      const first = nav.querySelector('.nav-item.k-nav-first');
      if (first) { e.preventDefault(); first.click(); setQ(''); }
    } else if (e.key === 'ArrowDown') {
      const first = [...nav.querySelectorAll(FOCUSABLE)].filter(visible).find((x) => x.classList.contains('nav-item'));
      if (first) { e.preventDefault(); first.focus(); }
    }
  };

  const shownRecent = recent.filter((r) => r.path !== currentPath).slice(0, 3);
  return (
    <div className="k-finder">
      <div className={`k-finder-box${searching ? ' is-on' : ''}`}>
        <FiSearch aria-hidden="true" />
        <input ref={inputRef} type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          placeholder="Find a screen…" aria-label="Find a screen in the menu" aria-describedby="k-finder-hint"
          autoComplete="off" spellCheck="false" />
        {searching
          ? <button type="button" className="k-finder-clear" onClick={() => { setQ(''); inputRef.current && inputRef.current.focus(); }} aria-label="Clear search"><FiX aria-hidden="true" /></button>
          : <kbd className="k-finder-kbd" aria-hidden="true">Ctrl K</kbd>}
      </div>
      <div id="k-finder-hint" className="k-finder-hint" role="status" aria-live="polite">
        {searching ? (hits ? `${hits} screen${hits === 1 ? '' : 's'} · Enter opens the first` : `No screen matches "${q.trim()}"`) : ''}
      </div>
      {!searching && shownRecent.length > 0 && (
        <div className="k-recent" aria-label="Recently used screens">
          <div className="k-recent-head"><FiClock aria-hidden="true" /> Recent</div>
          <div className="k-recent-list">
            {shownRecent.map((r) => (
              <button key={r.path} type="button" className="k-recent-chip" onClick={() => onOpenRecent(r.path)} title={r.label}>{r.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
