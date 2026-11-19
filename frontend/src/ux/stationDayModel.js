// UX-10 — the station-day ring's arithmetic (pure, tested): four steps, each
// a quarter of the ring, each quarter filled by how much of it is done.
export function ringSegments(steps) {
  const list = (steps || []).slice(0, 4);
  return list.map((s, i) => {
    const total = Number(s.total) || 0, done = Math.min(Number(s.done) || 0, total);
    return { ...s, index: i, frac: total > 0 ? done / total : 0, complete: total > 0 && done >= total, idle: total === 0 };
  });
}

// "3 of 4 steps done" — only steps that have work in them count.
export function dayProgress(steps) {
  const segs = ringSegments(steps).filter((s) => !s.idle);
  return { done: segs.filter((s) => s.complete).length, total: segs.length };
}

// SVG arc path for a ring segment (angles in degrees, 0 = top, clockwise).
export function arcPath(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
