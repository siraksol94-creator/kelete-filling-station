import { useEffect, useRef } from 'react';

const isMobileViewport = () =>
  typeof window !== 'undefined' && window.innerWidth <= 768;

/**
 * useModalScrollLock — keep .page-content from scrolling underneath a modal
 * on mobile, and restore the user's scroll position when it closes.
 *
 * Pass a boolean that's true whenever ANY modal on the page is open. The hook
 * compares it on every render — when it flips true, the current .page-content
 * scrollTop is captured and frozen at 0; when it flips back, the saved
 * position is restored in the next frame so the user lands on the row they
 * tapped.
 *
 * No-op on desktop. Falls through silently if .page-content can't be found.
 *
 * Usage:
 *   useModalScrollLock(!!viewModal || showForm || !!payModal);
 */
export default function useModalScrollLock(anyModalOpen) {
  const savedScrollTop = useRef(0);

  useEffect(() => {
    if (!isMobileViewport()) return;
    const pc = document.querySelector('.page-content');
    if (!pc) return;

    if (anyModalOpen) {
      savedScrollTop.current = pc.scrollTop;
      pc.style.overflow = 'hidden';
      pc.scrollTop = 0;
      document.body.style.overflow = 'hidden';
    } else {
      pc.style.overflow = '';
      document.body.style.overflow = '';
      // Wait one frame so the list re-renders before we jump back.
      requestAnimationFrame(() => { pc.scrollTop = savedScrollTop.current; });
    }

    return () => {
      if (pc) pc.style.overflow = '';
      document.body.style.overflow = '';
    };
  }, [anyModalOpen]);
}
