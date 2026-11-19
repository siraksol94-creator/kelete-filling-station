// UX-1 — the React side of ux/hotkeys.js (kept apart so the matching logic
// stays dependency-free and testable without React).
import { useEffect, useRef } from 'react';
import { pickBinding } from './hotkeys';

export function useHotkeys(bindings, { enabled = true } = {}) {
  const ref = useRef(bindings);
  ref.current = bindings;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      const b = pickBinding(e, ref.current);
      if (!b) return;
      e.preventDefault();
      b.run(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
