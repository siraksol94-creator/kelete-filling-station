// Shared inline styles for the Kelete Fuel pages. Keeping them inline to
// avoid needing a CSS build step for the first slice.
// Mix a #rrggbb colour toward black by `amount` (0–1). Anything else passes through.
export function shade(hex, amount) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v) => Math.round(v * (1 - amount)).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

export const S = {
  // Shared container for every Fuel Station sub-page. height + overflow-y
  // ensure content taller than the viewport scrolls independently of the
  // sidebar — matches how the HQ pages scroll in Redsea.
  // Extra bottom padding so the last row isn't buried under Android's
  // address bar / nav bar when they re-appear on scroll.
  page: { padding: '24px 24px 96px', height: 'calc(100vh - 56px)', overflowY: 'auto', boxSizing: 'border-box' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' },
  h2: { margin: 0, display: 'flex', alignItems: 'center', gap: 10, fontSize: 22, fontWeight: 800, letterSpacing: '-0.01em', color: '#0f172a' },
  // UX-1: cards scroll sideways instead of clipping wide tables on small screens.
  // UX-7 — the Forecourt kit look: slate ink, soft cards, tabular figures.
  card: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, overflowX: 'auto', overflowY: 'hidden', boxShadow: '0 1px 2px rgba(15,23,42,.04)' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', padding: '11px 16px', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#475569', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' },
  td: { padding: '12px 16px', fontSize: 14, color: '#0f172a', fontVariantNumeric: 'tabular-nums' },
  tdR: { padding: '12px 16px', fontSize: 14, textAlign: 'right', color: '#0f172a', fontVariantNumeric: 'tabular-nums' },
  btnPrimary: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, padding: '0 16px', background: '#0f172a', color: '#fff', border: 0, borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14 },
  btnSecondary: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, padding: '0 14px', background: '#fff', color: '#0f172a', border: '1px solid #cbd5e1', borderRadius: 10, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
  btnDanger: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 40, padding: '0 16px', background: '#b91c1c', color: '#fff', border: 0, borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14 },
  iconBtn: { background: 'transparent', border: 0, padding: 7, borderRadius: 8, cursor: 'pointer', color: '#334155', marginRight: 4 },
  iconBtnDanger: { background: 'transparent', border: 0, padding: 7, borderRadius: 8, cursor: 'pointer', color: '#b91c1c', marginRight: 4 },
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#fff', borderRadius: 16, width: 'min(640px, 94vw)', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 24px 60px rgba(15,23,42,0.28)' },
  modalHeader: { padding: '18px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  modalFooter: { padding: '16px 20px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
  formGrid: { padding: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },
  lbl: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5, fontWeight: 700, color: '#334155' },
  input: { padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: 10, fontSize: 14, marginTop: 2, minHeight: 40, boxSizing: 'border-box', color: '#0f172a', background: '#fff', fontVariantNumeric: 'tabular-nums' },
  errBox: { margin: 20, padding: 12, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 10, fontSize: 14 },
  // UX-2: the text is a darker shade of the pill colour, so it stays readable
  // (≥ 4.5:1) on its own light tint — e.g. green "Open" was 3:1 before.
  pill: (color) => ({ display: 'inline-block', padding: '2px 10px', borderRadius: 999, background: color + '22', color: shade(color, 0.42), fontSize: 12, fontWeight: 600 }),
  statCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 16 },
  statLabel: { fontSize: 11.5, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 },
  statValue: { fontSize: 24, fontWeight: 800, marginTop: 4, color: '#0f172a', fontVariantNumeric: 'tabular-nums' },
  bar: (pct, color = '#2563eb') => ({
    height: 8, borderRadius: 4, background: '#e5e7eb', overflow: 'hidden', position: 'relative', marginTop: 8,
  }),
  barFill: (pct, color = '#2563eb') => ({
    width: `${Math.min(100, Math.max(0, pct))}%`,
    height: '100%', background: color, borderRadius: 4,
  }),
};
