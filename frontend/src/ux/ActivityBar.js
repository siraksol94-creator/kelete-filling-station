// UX-2 — the thin bar at the top of every screen while the app is fetching
// something you asked for: a little car drives along it, fuel trailing behind.
import React, { useEffect, useRef, useState } from 'react';
import { activity } from './activity';
import { FuelCar } from './FuelLoader';

const SHOW_AFTER_MS = 300;   // quick answers never flash the bar
const MIN_VISIBLE_MS = 400;  // once shown, don't blink off instantly

export default function ActivityBar({ store = activity }) {
  const [visible, setVisible] = useState(false);
  const showTimer = useRef(null);
  const shownAt = useRef(0);
  useEffect(() => store.subscribe((n) => {
    if (n > 0) {
      if (!visible && !showTimer.current) {
        showTimer.current = setTimeout(() => { showTimer.current = null; shownAt.current = Date.now(); setVisible(true); }, SHOW_AFTER_MS);
      }
    } else {
      if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
      const left = MIN_VISIBLE_MS - (Date.now() - shownAt.current);
      setTimeout(() => { if (store.pending() === 0) setVisible(false); }, Math.max(0, left));
    }
  }), [store, visible]);
  if (!visible) return null;
  return (
    <div className="k-activity" role="status" aria-label="Loading">
      <div className="k-activity-track"><div className="k-activity-fuel" /></div>
      <FuelCar width={30} className="k-activity-car" />
    </div>
  );
}
