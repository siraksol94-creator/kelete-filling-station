// v1.8.34 — Quick Price Update.
// v1.10.26 — Mirrors the Item Details pricing rule (v1.8.71):
//   • Editing the DEFAULT unit cascades to every packaging (base_price =
//     entered / conv, siblings re-derive from base × their conv) and
//     clears all per-unit overrides for that product.
//   • Editing a NON-DEFAULT unit stores a per-unit override — base and
//     other cells stay put. This is what lets a shop sell Six Pack at
//     an unequal price without wrecking the Box price.
// Previously every edit back-solved basePrice from that cell's conv, so
// editing Six Pack changed Bottle AND Box in lockstep — the bug the user
// hit when trying to reprice Heineken Ordinary Six Pack.
import React, { useEffect, useMemo, useState } from 'react';
import { getProducts, bulkUpdatePrices } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiSearch, FiSave, FiRefreshCw } from 'react-icons/fi';
import { matchTokens } from '../utils/tokenSearch';

const fmt2 = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Which packaging is treated as the DEFAULT for cascade purposes.
// Falls back to the base unit (conv=1) when product has no default_unit set.
const defaultUnitName = (product) => {
  const dflt = (product.default_unit || '').trim();
  if (dflt) return dflt;
  const baseUnit = product._units.find(u => u.is_base) || product._units[product._units.length - 1];
  return baseUnit?.name || '';
};

const QuickPrice = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [search, setSearch]     = useState('');
  // Map<productId, basePricePerBaseUnit>. Drives every cell whose unit
  // does NOT have an override in unitPrices[productId].
  const [basePrices, setBasePrices] = useState({});
  const [initialBase, setInitialBase] = useState({});
  // v1.10.26 — Map<productId, Map<unitName, overridePrice>>. Present only
  // for non-default cells the user edited independently. Cells NOT in this
  // map render as basePrice × conv. Editing the default unit CLEARS this
  // whole product's map.
  const [unitPrices, setUnitPrices] = useState({});
  const [initialUnitPrices, setInitialUnitPrices] = useState({});
  // Track which cell is currently focused + its raw text. The focused cell
  // shows verbatim so "3" doesn't reformat to "3.00" mid-typing.
  const [editingKey, setEditingKey] = useState(null);   // e.g. "12:Box"
  const [editingRaw, setEditingRaw] = useState('');
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await getProducts();
      const list = Array.isArray(data) ? data : [];
      const enriched = list.map(p => {
        let units = [];
        try { units = JSON.parse(p.units_json || '[]'); } catch {}
        units = Array.isArray(units) ? units.filter(u => u && u.name) : [];
        // Sort: biggest conv first, base last.
        units.sort((a, b) => parseFloat(b.conv || 0) - parseFloat(a.conv || 0));
        return { ...p, _units: units };
      }).filter(p => p._units.length > 0);
      setProducts(enriched);
      // basePrice per product = price of the base unit (conv=1) or the
      // stored selling_price fallback. Non-base units get compared against
      // basePrice × conv — mismatches become overrides.
      const base = {};
      const overrides = {};
      for (const p of enriched) {
        const baseUnit = p._units.find(u => u.is_base) || p._units[p._units.length - 1];
        const v = parseFloat(baseUnit?.price);
        const bp = isNaN(v) || v <= 0 ? parseFloat(p.selling_price || 0) || 0 : v;
        base[p.id] = bp;
        const productOverrides = {};
        for (const u of p._units) {
          if (u.is_base) continue;
          const stored = parseFloat(u.price);
          const derived = bp * (parseFloat(u.conv) || 0);
          // Treat any stored price that differs from the derived by more
          // than 1 cent as an intentional override. Rounds well against
          // the toFixed(4) precision the backend saves at.
          if (stored > 0 && Math.abs(stored - derived) > 0.01) {
            productOverrides[u.name] = stored;
          }
        }
        if (Object.keys(productOverrides).length > 0) {
          overrides[p.id] = productOverrides;
        }
      }
      setBasePrices(base);
      setInitialBase({ ...base });
      setUnitPrices(overrides);
      setInitialUnitPrices(JSON.parse(JSON.stringify(overrides)));
    } catch (e) {
      showToast('Failed to load products: ' + (e?.response?.data?.error || e.message), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Edit handler. Two paths:
  //   • Default unit → cascade (base = entered/conv, clear all overrides).
  //   • Non-default   → store override for that unit only.
  const handleCellChange = (product, unit, newDisplayValue) => {
    const cellKey = `${product.id}:${unit.name}`;
    setEditingKey(cellKey);
    setEditingRaw(newDisplayValue);
    const v = parseFloat(newDisplayValue);
    const safe = isNaN(v) || v < 0 ? 0 : v;
    const conv = parseFloat(unit.conv) || 1;
    const dfltName = defaultUnitName(product);
    const isDefault = (unit.name || '').trim() === dfltName;
    if (isDefault) {
      setBasePrices(prev => ({ ...prev, [product.id]: safe / conv }));
      setUnitPrices(prev => {
        if (!prev[product.id]) return prev;
        const next = { ...prev };
        delete next[product.id];
        return next;
      });
    } else {
      setUnitPrices(prev => {
        const forProduct = { ...(prev[product.id] || {}) };
        if (newDisplayValue === '' || safe === 0) {
          delete forProduct[unit.name];
        } else {
          forProduct[unit.name] = safe;
        }
        const next = { ...prev };
        if (Object.keys(forProduct).length === 0) delete next[product.id];
        else next[product.id] = forProduct;
        return next;
      });
    }
  };

  // Visible value for a cell: override if present, else basePrice × conv.
  const cellValue = (productId, unit) => {
    const override = unitPrices[productId]?.[unit.name];
    if (override !== undefined && override !== null) return override;
    const base = basePrices[productId] || 0;
    const c = parseFloat(unit.conv) || 1;
    return base * c;
  };

  const filteredProducts = useMemo(() => {
    return products.filter(p => matchTokens(search, p.name, p.code, p.barcode));
  }, [products, search]);

  // Dirty when basePrice differs OR any unit override differs from initial.
  const dirtyIds = useMemo(() => {
    const out = new Set();
    const check = (id) => {
      const a = parseFloat(basePrices[id] || 0);
      const b = parseFloat(initialBase[id] || 0);
      if (Math.abs(a - b) > 0.00001) return true;
      const cur = unitPrices[id] || {};
      const init = initialUnitPrices[id] || {};
      const keys = new Set([...Object.keys(cur), ...Object.keys(init)]);
      for (const k of keys) {
        const cv = parseFloat(cur[k] || 0);
        const iv = parseFloat(init[k] || 0);
        if (Math.abs(cv - iv) > 0.01) return true;
      }
      return false;
    };
    for (const id of Object.keys(basePrices)) {
      if (check(id)) out.add(parseInt(id, 10));
    }
    // Also catch products whose base didn't change but overrides did.
    for (const id of Object.keys(unitPrices)) {
      if (out.has(parseInt(id, 10))) continue;
      if (check(id)) out.add(parseInt(id, 10));
    }
    return out;
  }, [basePrices, initialBase, unitPrices, initialUnitPrices]);

  const handleSaveAll = async () => {
    if (dirtyIds.size === 0) return;
    if (!window.confirm(`Save ${dirtyIds.size} price change${dirtyIds.size > 1 ? 's' : ''}?`)) return;
    setSaving(true);
    try {
      // Payload: base_price for the cascade + unit_prices for per-unit
      // overrides. Backend applies base × conv to every unit, then
      // overlays unit_prices on top.
      const updates = Array.from(dirtyIds).map(id => {
        const payload = { id, base_price: basePrices[id] };
        const overrides = unitPrices[id];
        if (overrides && Object.keys(overrides).length > 0) {
          payload.unit_prices = overrides;
        }
        return payload;
      });
      await bulkUpdatePrices(updates);
      showToast(`${updates.length} product${updates.length > 1 ? 's' : ''} updated.`);
      setInitialBase(prev => {
        const next = { ...prev };
        for (const u of updates) next[u.id] = u.base_price;
        return next;
      });
      setInitialUnitPrices(JSON.parse(JSON.stringify(unitPrices)));
    } catch (e) {
      showToast('Save failed: ' + (e?.response?.data?.error || e.message), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (dirtyIds.size === 0) return;
    if (!window.confirm(`Discard ${dirtyIds.size} unsaved change${dirtyIds.size > 1 ? 's' : ''}?`)) return;
    setBasePrices({ ...initialBase });
    setUnitPrices(JSON.parse(JSON.stringify(initialUnitPrices)));
  };

  if (!hasPermission('Items:Edit') && !hasPermission('Items:QuickPrice')) {
    return <div style={{ padding: 40 }}><h2>Access denied</h2><p>You don't have permission to edit prices.</p></div>;
  }

  return (
    <div className="page-content">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Quick Price Update</h1>
          <p>Editing the <strong>default</strong> unit cascades to the rest. Editing another unit stores a per-unit override. {dirtyIds.size > 0 && <strong style={{ color: '#d97706' }}>{dirtyIds.size} unsaved change{dirtyIds.size > 1 ? 's' : ''}</strong>}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {dirtyIds.size > 0 && (
            <button onClick={handleDiscard} disabled={saving}
              style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <FiRefreshCw size={14} /> Discard
            </button>
          )}
          <button onClick={handleSaveAll} disabled={saving || dirtyIds.size === 0}
            style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: dirtyIds.size > 0 ? '#16a34a' : '#cbd5e1', color: '#fff', cursor: dirtyIds.size > 0 ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <FiSave size={15} /> {saving ? 'Saving…' : `Save All Changes${dirtyIds.size > 0 ? ` (${dirtyIds.size})` : ''}`}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0 18px' }}>
        <div style={{ position: 'relative', flex: '0 0 360px' }}>
          <FiSearch style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} size={15} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search product name or code…"
            style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 10, border: '1.5px solid #e5e7eb', fontSize: 13, background: '#fff', outline: 'none' }} />
        </div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{filteredProducts.length} of {products.length} products</div>
      </div>

      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#94a3b8' }}>Loading products…</div>
      ) : filteredProducts.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', background: '#fff', borderRadius: 12 }}>No products match.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {filteredProducts.map(p => {
            const isDirty = dirtyIds.has(p.id);
            const dfltName = defaultUnitName(p);
            return (
              <div key={p.id} style={{
                background: '#fff',
                border: `1.5px solid ${isDirty ? '#f59e0b' : '#e5e7eb'}`,
                borderRadius: 12,
                padding: 14,
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              }}>
                <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px dashed #e5e7eb' }}>
                  <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 14, lineHeight: 1.2 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>
                    {p.code}
                    {isDirty && <span style={{ marginLeft: 8, color: '#d97706', fontWeight: 700 }}>● unsaved</span>}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {p._units.map((u, i) => {
                    const cellKey = `${p.id}:${u.name}`;
                    const isEditing = editingKey === cellKey;
                    const derived = cellValue(p.id, u);
                    const displayValue = isEditing ? editingRaw : (derived === 0 ? '' : derived.toFixed(2));
                    const isLast = i === p._units.length - 1;
                    const isDefault = (u.name || '').trim() === dfltName;
                    const hasOverride = unitPrices[p.id]?.[u.name] !== undefined;
                    return (
                      <React.Fragment key={u.name}>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <span>{u.name}{u.is_base && parseFloat(u.conv) === 1 ? '' : ` (1 ${u.name} = ${u.conv} ${p._units[p._units.length - 1].name})`}</span>
                            {isDefault && (
                              <span style={{ background: '#dbeafe', color: '#1d4ed8', padding: '1px 6px', borderRadius: 4, fontSize: 9, letterSpacing: 0.4 }}>DEFAULT</span>
                            )}
                            {hasOverride && !isDefault && (
                              <span style={{ background: '#fef3c7', color: '#b45309', padding: '1px 6px', borderRadius: 4, fontSize: 9, letterSpacing: 0.4 }}>OVERRIDE</span>
                            )}
                          </label>
                          <div style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: '#94a3b8', pointerEvents: 'none', fontWeight: 600 }}>{curSym}</span>
                            <input
                              type="text" inputMode="decimal"
                              value={displayValue}
                              onChange={e => handleCellChange(p, u, e.target.value)}
                              onBlur={() => { setEditingKey(null); setEditingRaw(''); }}
                              onFocus={() => { setEditingKey(cellKey); setEditingRaw(displayValue); }}
                              onWheel={e => e.target.blur()}
                              placeholder="0.00"
                              style={{
                                width: '100%', padding: '11px 12px 11px 28px',
                                borderRadius: 8, fontSize: 16, fontWeight: 700,
                                border: `2px solid ${isDirty ? '#f59e0b' : (isDefault ? '#93c5fd' : '#e5e7eb')}`,
                                background: isDirty ? '#fffbeb' : (isDefault ? '#eff6ff' : '#fff'),
                                color: '#0f172a', outline: 'none',
                                boxSizing: 'border-box',
                                textAlign: 'right',
                              }} />
                          </div>
                        </div>
                        {!isLast && (
                          <div style={{ textAlign: 'center', color: '#cbd5e1', fontSize: 14, lineHeight: 1 }}>↓</div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '12px 20px', borderRadius: 10, background: toast.type === 'error' ? '#dc2626' : '#16a34a', color: '#fff', fontWeight: 600, fontSize: 13, boxShadow: '0 10px 24px rgba(0,0,0,0.15)', zIndex: 9999 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
};

export default QuickPrice;
