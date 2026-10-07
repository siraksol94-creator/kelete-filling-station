// tokenSearch — v1.10.6
// Multi-token, order-independent, case-insensitive substring match used by
// every search box in the app.
//
//   matchTokens('savan 330', product.name, product.code)
//     → true for "SAVANNA 330ML"  (tokens: 'savan' + '330' both present)
//     → true for "330 SAVAN box"  (order irrelevant)
//     → false for "SAVANNA 500ML" (no '330' token)
//
// Empty query returns true so filters degrade to a no-op.
export function matchTokens(query, ...fields) {
  if (!query) return true;
  const q = String(query).toLowerCase().trim();
  if (!q) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  // Use a control-character separator between fields so a token can't
  // accidentally straddle two fields (e.g. "SAVAN|330" query hitting
  // a code "SAVAN" + adjacent name "330 CANE").
  const hay = fields.map(f => String(f == null ? '' : f).toLowerCase()).join(' \x1f ');
  return tokens.every(t => hay.includes(t));
}
