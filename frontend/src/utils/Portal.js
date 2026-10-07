import { createPortal } from 'react-dom';

/**
 * Portal — render children into document.body, outside the normal React tree.
 *
 * Why this exists: a transformed ancestor in the layout (likely the sidebar
 * slide-in transition or one of the CSS mobile rules) breaks `position: fixed`
 * on modals, so they pin to the document instead of the viewport. When the
 * user is scrolled down a list and taps "View", the modal renders above the
 * fold and they can't find it. Rendering into <body> bypasses that ancestor
 * chain entirely.
 *
 * Usage:
 *   {open && (
 *     <Portal>
 *       <div style={{ position: 'fixed', inset: 0, ... }}>...</div>
 *     </Portal>
 *   )}
 */
const Portal = ({ children, container }) => {
  if (typeof document === 'undefined') return null;
  return createPortal(children, container || document.body);
};

export default Portal;
