// UX-1 — keyboard shortcuts for the fuel screens.
//
//   useHotkeys([   (from ux/useHotkeys.js — this file is the pure part, tested in CI)
//     { combo: 'mod+enter', run: save, label: 'Save', allowInInputs: true },
//     { combo: 'alt+n',     run: openNew, label: 'New shift' },
//   ], { enabled: true });
//
// • "mod" is Ctrl on Windows/Linux and ⌘ on a Mac.
// • Single keys ("?", "[", "]", "n") never fire while typing in a field;
//   combinations with Ctrl/⌘/Alt do when allowInInputs is set.
// • A shortcut only does what a button on the screen already does, and only
//   when that button is shown and enabled — screens pass enabled:false (or
//   omit the binding) for actions the user's role doesn't have.

export function parseCombo(combo) {
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() || '';
  const mods = new Set(parts);
  return { key, mod: mods.has('mod'), ctrl: mods.has('ctrl'), alt: mods.has('alt'), shift: mods.has('shift'), meta: mods.has('meta') };
}

const KEY_ALIASES = { esc: 'escape', return: 'enter', left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown' };

export function matchHotkey(event, combo) {
  if (!event) return false;
  const c = parseCombo(combo);
  const want = KEY_ALIASES[c.key] || c.key;
  const got = String(event.key || '').toLowerCase();
  // Alt+letter types a special character on a Mac (Alt+N → "˜"): fall back to
  // the physical key for letters and digits.
  const physical = /^[a-z]$/.test(want) ? `key${want}` : /^[0-9]$/.test(want) ? `digit${want}` : null;
  if (got !== want && !(physical && String(event.code || '').toLowerCase() === physical)) return false;
  const ctrlish = !!(event.ctrlKey || event.metaKey);
  if (c.mod) { if (!ctrlish) return false; }
  else {
    if (!!event.ctrlKey !== c.ctrl) return false;
    if (!!event.metaKey !== c.meta) return false;
  }
  if (!!event.altKey !== c.alt) return false;
  // "?" is shift+/ on most keyboards: don't demand an explicit shift for it.
  if (c.shift && !event.shiftKey) return false;
  if (!c.shift && event.shiftKey && want.length > 1 && want !== '?') return false;
  return true;
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return !!el.isContentEditable;
}

const hasModifier = (combo) => { const c = parseCombo(combo); return c.mod || c.ctrl || c.alt || c.meta; };

// Pure dispatcher (tested): returns the binding that should run, or null.
export function pickBinding(event, bindings) {
  const typing = isTypingTarget(event && event.target);
  for (const b of bindings || []) {
    if (!b || b.enabled === false || typeof b.run !== 'function') continue;
    if (!matchHotkey(event, b.combo)) continue;
    if (typing && !(b.allowInInputs && hasModifier(b.combo)) && !(b.allowInInputs && parseCombo(b.combo).key === 'escape')) continue;
    return b;
  }
  return null;
}

// Display form: "mod+enter" → "Ctrl + Enter" (or "⌘ + Enter" on a Mac).
export function comboLabel(combo, isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')) {
  const names = { mod: isMac ? '⌘' : 'Ctrl', ctrl: 'Ctrl', alt: isMac ? '⌥' : 'Alt', shift: 'Shift', meta: '⌘', enter: 'Enter', escape: 'Esc', esc: 'Esc' };
  return String(combo).split('+').map((p) => names[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join(' + ');
}
