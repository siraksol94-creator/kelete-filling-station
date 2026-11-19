// UX-4 — tanks plumbed together (same group_code, e.g. T1 + T3) are drawn
// side by side, joined by a pipe. Pure (tested in CI): which tanks go
// together, their combined fuel, and which way fuel is settling.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pctOf = (t) => (num(t.capacity) > 0 ? Math.max(0, Math.min(1, num(t.volume) / num(t.capacity))) : 0);

// [{ kind: 'single', tank } | { kind: 'group', code, tanks, volume, capacity, links }]
// in the order the tanks came, a group placed where its first tank was.
// links[i] joins tanks[i] and tanks[i+1]: dir 'right' | 'left' | 'still'
// (fuel moves from the fuller tank) and strength 0…1 for how fast it looks.
export function groupTanks(tanks) {
  const out = [];
  const groups = new Map();
  for (const t of tanks || []) {
    const code = String(t.group_code || '').trim().toUpperCase();
    if (!code) { out.push({ kind: 'single', tank: t }); continue; }
    if (!groups.has(code)) { const g = { kind: 'group', code, tanks: [] }; groups.set(code, g); out.push(g); }
    groups.get(code).tanks.push(t);
  }
  return out.map((item) => {
    if (item.kind !== 'group') return item;
    if (item.tanks.length < 2) return { kind: 'single', tank: item.tanks[0] };
    const links = [];
    for (let i = 0; i < item.tanks.length - 1; i += 1) {
      const d = pctOf(item.tanks[i]) - pctOf(item.tanks[i + 1]);
      links.push({ dir: Math.abs(d) < 0.01 ? 'still' : d > 0 ? 'right' : 'left', strength: Math.min(1, Math.abs(d) / 0.2) });
    }
    return {
      ...item,
      volume: item.tanks.reduce((a, t) => a + Math.max(0, num(t.volume)), 0),
      capacity: item.tanks.reduce((a, t) => a + num(t.capacity), 0),
      links,
    };
  });
}

export const groupLabel = (g) => g.tanks.map((t) => t.code).join(' + ');
