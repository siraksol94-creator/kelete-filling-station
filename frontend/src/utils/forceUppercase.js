// forceUppercase — every text box types in capital letters.
//
// 2026-09-16. Red Sea asked for block letters on every input. One listener
// instead of editing ~70 fields: it runs in the capture phase, before React's
// own input handler, turns the box's value to capitals and puts the cursor
// back, so React's onChange receives the capitals and stores them. Fields
// added later get it automatically. Only new typing changes; saved records
// keep whatever letters they already have.
//
// Left as typed:
//   - passwords, emails, URLs, numbers, dates, files and other non-text types
//   - usernames, search boxes, keys, IPs, ports, printer names, links
//     (matched on autocomplete / name / id / placeholder / aria-label)
//   - the Messages page (chat) and the ZRA Smart Invoice settings page
//   - anything inside an element marked data-keep-case

const KEEP_PAGES = [/^\/messages/, /^\/settings\/zra/];
// Whole words where a short word could sit inside an ordinary one
// ("port" in Transport / Report, "key" in Whiskey).
const KEEP_HINT = /user ?name|password|e-?mail|search|\burl\b|website|https?:|\bip\b|\bhost\b|\bport\b|\bkey\b|token|\bslug\b|printer|\blink\b/i;

function shouldUppercase(el) {
  if (!el || el.readOnly || el.disabled) return false;
  if (el.tagName === 'INPUT') {
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (type !== 'text') return false;
    // 2026-09-16 — a pick-from-a-list box (<input list=…>) chooses an existing
    // record by its exact name. Capitalising the picked "AQUA CLEAR 1000mls
    // (Box)" made Sales Bin Card, Store Bin Card and GRN Goods Return find no
    // match ("Please select a product").
    if (el.hasAttribute('list')) return false;
  } else if (el.tagName !== 'TEXTAREA') {
    return false;
  }
  if (KEEP_PAGES.some((re) => re.test(window.location.pathname))) return false;
  if (el.closest('[data-keep-case]')) return false;
  const hint = [
    el.getAttribute('autocomplete'), el.name, el.id,
    el.getAttribute('placeholder'), el.getAttribute('aria-label'),
  ].filter(Boolean).join(' ');
  return !KEEP_HINT.test(hint);
}

// Write the value the keyboard's way.
//
// 2026-09-16 — a plain `el.value = upper` went through the value setter React
// puts on the node, which ALSO updates React's record of what the box last
// held. React then compared its record with the box, saw no difference and
// dropped the change: the box showed JOHN while the form kept nothing, and the
// next keystroke in another field redrew the form and wiped First and Last
// names on Add New User. The prototype's own setter leaves React's record
// alone, so React sees the change and stores the capitals.
function setValue(el, value) {
  try {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) { setter.call(el, value); return; }
  } catch (_) { /* fall through */ }
  el.value = value;
}

export default function installForceUppercase() {
  if (typeof window === 'undefined' || window.__rsForceUppercase) return;
  window.__rsForceUppercase = true;
  window.addEventListener('input', (e) => {
    const el = e.target;
    if (e.isComposing || !shouldUppercase(el)) return;
    const value = el.value;
    const upper = value.toUpperCase();
    // Same length only: a letter that grows when capitalised (e.g. ß → SS)
    // would push the cursor out of place, so that rare case is left alone.
    if (upper === value || upper.length !== value.length) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setValue(el, upper);
    try { if (start != null) el.setSelectionRange(start, end); } catch (_) { /* not supported on this box */ }
  }, true);
}

export { shouldUppercase };
