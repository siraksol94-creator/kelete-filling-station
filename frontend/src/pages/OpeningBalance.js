// v1.13.153 â€” Opening Balance.
//
// Standing up a new depot: what it holds, what that stock cost, and what it
// sells for â€” on one screen, one row per item. Deliberately the same card grid
// as Quick Price (v1.8.34) because it is the same job with two more columns,
// and a second layout to learn would be a second layout to get wrong.
//
// It opens PRE-FILLED with what the branch holds now. A blank page invites
// re-declaring a balance that already exists; a filled one makes you type over
// a real number, which is a decision rather than an accident.
//
// REPLACE, NOT ADD â€” the backend edits the single opening row in place, so
// entering 500 twice leaves 500, not 1000. Nothing in the app would have
// caught the doubling: there is no stock guard anywhere in routes/orders.js.
//
// Prices use the same cascade as Quick Price (editing the default unit
// cascades to every packaging; editing another stores an override), because
// the till reads its price out of units_json, not selling_price.
import React, { useEffect, useMemo, useState } from 'react';
import { getProducts, getOpeningBalances, saveOpeningBalances, getBranchSlug } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiSearch, FiSave, FiRefreshCw, FiPackage, FiPrinter } from 'react-icons/fi';
import { matchTokens } from '../utils/tokenSearch';

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

// Which packaging is the DEFAULT for cascade purposes. Same rule as
// QuickPrice.js â€” falls back to the base unit when default_unit is unset.
const defaultUnitName = (product) => {
  const dflt = (product.default_unit || '').trim();
  if (dflt) return dflt;
  const baseUnit = product._units.find(u => u.is_base) || product._units[product._units.length - 1];
  return baseUnit?.name || '';
};

const OpeningBalance = () => {
  const { hasPermission, user } = useAuth();
  const { symbol: curSym } = useCurrency();
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [search, setSearch]     = useState('');
  const [onlyUnset, setOnlyUnset] = useState(false);

  // Three parallel maps keyed by product id, each with its "as loaded" twin so
  // a cell counts as changed only when it differs from what the branch holds.
  const [qty,  setQty]  = useState({});
  const [cost, setCost] = useState({});
  const [basePrices, setBasePrices] = useState({});
  const [initialQty,  setInitialQty]  = useState({});
  const [initialCost, setInitialCost] = useState({});
  const [initialBase, setInitialBase] = useState({});
  const [unitPrices, setUnitPrices] = useState({});
  const [initialUnitPrices, setInitialUnitPrices] = useState({});

  // The focused cell renders verbatim so "3" doesn't reformat to "3.00"
  // while it is still being typed.
  const [editingKey, setEditingKey] = useState(null);
  const [editingRaw, setEditingRaw] = useState('');
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = async () => {
    setLoading(true);
    try {
      // Both together: the catalogue, and what stock is already declared.
      const [prodRes, openRes] = await Promise.all([getProducts(), getOpeningBalances()]);
      const list = Array.isArray(prodRes.data) ? prodRes.data : [];
      const openings = Array.isArray(openRes.data) ? openRes.data : [];
      const bySync = {};
      for (const o of openings) bySync[o.product_sync_id] = o;

      const enriched = list.map(p => {
        let units = [];
        try { units = JSON.parse(p.units_json || '[]'); } catch (_) {}
        units = Array.isArray(units) ? units.filter(u => u && u.name) : [];
        units.sort((a, b) => num(b.conv) - num(a.conv));   // biggest first, base last
        const open = bySync[p.sync_id];
        return { ...p, _units: units, _open: open, _dupes: open ? num(open.row_count) : 0 };
      }).filter(p => p._units.length > 0);

      setProducts(enriched);

      const q = {}, c = {}, base = {}, overrides = {};
      for (const p of enriched) {
        q[p.id] = p._open ? num(p._open.opening_qty) : 0;
        c[p.id] = num(p.cost_price);
        const baseUnit = p._units.find(u => u.is_base) || p._units[p._units.length - 1];
        const v = num(baseUnit?.price);
        const bp = v <= 0 ? num(p.selling_price) : v;
        base[p.id] = bp;
        // A non-base cell that doesn't equal base x conv was priced by hand.
        // Same override test Quick Price uses, so the two pages agree on what
        // counts as deliberate.
        const po = {};
        for (const u of p._units) {
          if (u.is_base) continue;
          const stored = num(u.price);
          if (stored > 0 && Math.abs(stored - bp * num(u.conv)) > 0.01) po[u.name] = stored;
        }
        if (Object.keys(po).length) overrides[p.id] = po;
      }
      setQty(q);          setInitialQty({ ...q });
      setCost(c);         setInitialCost({ ...c });
      setBasePrices(base); setInitialBase({ ...base });
      setUnitPrices(overrides);
      setInitialUnitPrices(JSON.parse(JSON.stringify(overrides)));
    } catch (e) {
      showToast(e?.response?.data?.error || 'Could not load items', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const cellValue = (productId, unit) => {
    const override = unitPrices[productId]?.[unit.name];
    if (override !== undefined && override !== null) return override;
    return num(basePrices[productId]) * (num(unit.conv) || 1);
  };

  // Editing the default unit cascades and clears this product's overrides;
  // editing any other unit stores one. Mirrors Item Details and Quick Price.
  const handlePriceChange = (product, unit, raw) => {
    const key = `${product.id}:${unit.name}`;
    setEditingKey(key); setEditingRaw(raw);
    const entered = num(raw);
    const conv = num(unit.conv) || 1;
    if ((unit.name || '').trim() === defaultUnitName(product)) {
      setBasePrices(prev => ({ ...prev, [product.id]: entered / conv }));
      setUnitPrices(prev => { const n = { ...prev }; delete n[product.id]; return n; });
    } else {
      setUnitPrices(prev => ({ ...prev, [product.id]: { ...(prev[product.id] || {}), [unit.name]: entered } }));
    }
  };

  const filteredProducts = useMemo(() => {
    const base = products.filter(p => matchTokens(search, p.name, p.code, p.barcode));
    return onlyUnset ? base.filter(p => num(initialQty[p.id]) === 0) : base;
  }, [products, search, onlyUnset, initialQty]);

  const dirtyIds = useMemo(() => {
    const out = new Set();
    const changed = (id) => {
      if (Math.abs(num(qty[id])  - num(initialQty[id]))  > 0.00001) return true;
      if (Math.abs(num(cost[id]) - num(initialCost[id])) > 0.00001) return true;
      if (Math.abs(num(basePrices[id]) - num(initialBase[id])) > 0.00001) return true;
      const cur = unitPrices[id] || {}, init = initialUnitPrices[id] || {};
      for (const k of new Set([...Object.keys(cur), ...Object.keys(init)])) {
        if (Math.abs(num(cur[k]) - num(init[k])) > 0.01) return true;
      }
      return false;
    };
    for (const p of products) if (changed(p.id)) out.add(p.id);
    return out;
  }, [products, qty, cost, basePrices, unitPrices, initialQty, initialCost, initialBase, initialUnitPrices]);

  const handleSaveAll = async () => {
    if (dirtyIds.size === 0) return;

    // Two things worth stopping on before they reach a till, because nothing
    // downstream will: routes/orders.js has no price guard and no stock guard.
    const ids = Array.from(dirtyIds);
    const free = ids.filter(id => num(basePrices[id]) <= 0 && num(qty[id]) > 0);
    if (free.length) {
      const names = free.map(id => products.find(p => p.id === id)?.name).filter(Boolean);
      if (!window.confirm(
        `${free.length} item(s) have stock but NO selling price:\n\n${names.join('\n')}\n\n` +
        `A till will sell these for nothing. Save anyway?`)) return;
    }
    const noCost = ids.filter(id => num(cost[id]) <= 0 && num(qty[id]) > 0);
    if (noCost.length) {
      if (!window.confirm(
        `${noCost.length} item(s) have stock but no cost price.\n\n` +
        `Profit on those sales will read as 100% until a cost exists. Save anyway?`)) return;
    }

    const replacing = ids.filter(id => num(initialQty[id]) > 0 && num(qty[id]) !== num(initialQty[id]));
    const confirmMsg = replacing.length
      ? `Save ${dirtyIds.size} change(s)?\n\n${replacing.length} item(s) already have an opening balance. ` +
        `The existing figure is REPLACED, not added to.`
      : `Save ${dirtyIds.size} change(s)?`;
    if (!window.confirm(confirmMsg)) return;

    const password = window.prompt('Manager passcode to save opening balances:');
    if (!password) return;

    setSaving(true);
    try {
      const updates = ids.map(id => {
        const payload = {
          id,
          opening_qty: num(qty[id]),
          cost_price:  num(cost[id]),
          base_price:  num(basePrices[id]),
        };
        const o = unitPrices[id];
        if (o && Object.keys(o).length > 0) payload.unit_prices = o;
        return payload;
      });
      const { data } = await saveOpeningBalances(updates, password);
      showToast(`Saved ${data?.updated ?? updates.length} item(s).`);
      await load();
    } catch (e) {
      showToast(e?.response?.data?.error || e.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  // -- Verification sheet --------------------------------------------------
  // A4, not the 72mm roll every other print in this app uses. The last two
  // columns are BLANK BOXES FOR A PEN: someone walks the depot with this,
  // writes corrections in them, and keys them back in here. A receipt roll
  // cannot hold six columns and leaves nowhere to write.
  //
  // It prints SAVED values only - initialQty / initialBase, which load()
  // refreshes from the database after every save. Printing the on-screen
  // edits would put figures on paper that nobody can look up afterwards, so
  // unsaved changes block the print instead.
  const handlePrintSheet = () => {
    if (dirtyIds.size > 0) {
      showToast(`Save your ${dirtyIds.size} change(s) first - the sheet prints what the database holds.`, 'error');
      return;
    }

    // & before < , or the ampersand of an escaped entity gets escaped again.
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const fmtQty = (v) => Number.isInteger(v) ? String(v)
      : v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const fmtMoney = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Red Sea carries ONE unit per product, so quantity and price are always
    // in the same unit and there is nothing to disambiguate. The multi-unit
    // machinery (_units, is_base, conv) still runs everywhere else in the app;
    // it just never resolves to more than one here, which is why no unit name
    // is printed against the figures.
    const rows = products.map(p => ({
      code:  p.code || '',
      name:  p.name || '',
      qty:   num(initialQty[p.id]),
      price: num(initialBase[p.id]),
    }));

    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const inStock = rows.filter(r => r.qty > 0).sort(byName);
    // Negatives sit here with the zeros at the user's instruction. They are
    // still marked, because a negative means the till sold what the depot was
    // never given - the most urgent line on the sheet.
    const noStock = rows.filter(r => r.qty <= 0).sort(byName);

    const line = (r) => {
      const neg = r.qty < 0;
      const noPrice = !(r.price > 0);
      return `<tr>
        <td class="code">${esc(r.code)}</td>
        <td>${esc(r.name)}</td>
        <td class="n${neg ? ' warn' : ''}">${neg ? '&#9888; ' : ''}${fmtQty(r.qty)}</td>
        <td class="n${noPrice ? ' warn' : ''}">${noPrice ? '&#9888; &mdash;' : fmtMoney(r.price)}</td>
        <td class="write"></td>
        <td class="write"></td>
      </tr>`;
    };

    const section = (title, list) => !list.length ? '' : `
      <tr class="sect"><td colspan="4">${title}</td><td colspan="2" class="n">${list.length} item${list.length === 1 ? '' : 's'}</td></tr>
      ${list.map(line).join('')}`;

    // The subdomain IS the branch: chawama.keletezm.com. Electron
    // is always "localhost", so fall back to the slug cached at boot.
    const host = (window.location.hostname || '').split('.')[0];
    const slug = (!host || host === 'localhost' || host === '127') ? (getBranchSlug() || 'branch') : host;
    const branch = slug.toUpperCase();

    const now = new Date();
    const stamp = now.toLocaleString(undefined,
      { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const preparedBy = `${user?.first_name || ''} ${user?.last_name || ''}`.trim() || user?.email || '';

    // Browsers name a Save-as-PDF after the document title, so this IS the
    // filename the user asked for.
    const title = `${slug} Stock opening balance and Price list`;

    const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; color: #000;
         margin: 0; font-size: 9.5pt; }
  .head { margin-bottom: 6mm; }
  .co   { font-size: 13pt; font-weight: 700; letter-spacing: 0.3px; }
  .doc  { font-size: 10.5pt; font-weight: 700; margin-top: 1.5mm;
          display: flex; justify-content: space-between; align-items: baseline; }
  .meta { font-size: 8.5pt; color: #333; margin-top: 1.5mm;
          display: flex; justify-content: space-between; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead { display: table-header-group; }
  tr    { break-inside: avoid; page-break-inside: avoid; }
  th    { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.4px;
          border-bottom: 1.2pt solid #000; padding: 2mm 1.5mm; text-align: left;
          vertical-align: bottom; }
  th.n  { text-align: right; }
  td    { border-bottom: 0.4pt solid #bbb; padding: 2.1mm 1.5mm; height: 7mm;
          vertical-align: middle; overflow: hidden; }
  td.n  { text-align: right; font-variant-numeric: tabular-nums; }
  td.code { font-size: 8pt; color: #444; }
  .warn { font-weight: 700; }
  .write { background: #f0f0f0; border-left: 0.4pt solid #bbb; }
  tr.sect td { background: #000; color: #fff; font-weight: 700; font-size: 8pt;
               letter-spacing: 1px; text-transform: uppercase; height: auto;
               padding: 1.8mm 1.5mm; border: none; }
  .sign { margin-top: 8mm; font-size: 9pt; break-inside: avoid; page-break-inside: avoid; }
  .sign div { margin-bottom: 6mm; }
  .rule { display: inline-block; border-bottom: 0.6pt solid #000; }
  .empty { text-align: center; padding: 20mm; color: #666; }
</style></head><body>
  <div class="head">
    <div class="co">RED SEA IMPORT AND EXPORT ZAMBIA LTD</div>
    <div class="doc"><span>OPENING BALANCE VERIFICATION</span><span>${esc(branch)}</span></div>
    <div class="meta">
      <span>Printed ${esc(stamp)}</span>
      <span>${rows.length} items</span>
    </div>
  </div>

  ${rows.length === 0 ? '<div class="empty">No items.</div>' : `
  <table>
    <thead><tr>
      <th style="width:15mm">Code</th>
      <th style="width:60mm">Item</th>
      <th class="n" style="width:26mm">Opening<br>Balance</th>
      <th class="n" style="width:27mm">Selling<br>Price</th>
      <th class="n" style="width:27mm">Corrected<br>Balance</th>
      <th class="n" style="width:27mm">Corrected<br>Price</th>
    </tr></thead>
    <tbody>
      ${section('In stock', inStock)}
      ${section('No stock', noStock)}
    </tbody>
  </table>`}

  <div class="sign">
    <div>Prepared by&nbsp; <strong>${esc(preparedBy)}</strong>
         &nbsp;&nbsp;&nbsp;Signature <span class="rule" style="width:45mm">&nbsp;</span>
         &nbsp;&nbsp;Date <span class="rule" style="width:32mm">&nbsp;</span></div>
    <div>Checked by&nbsp; <span class="rule" style="width:52mm">&nbsp;</span>
         &nbsp;&nbsp;&nbsp;Signature <span class="rule" style="width:45mm">&nbsp;</span>
         &nbsp;&nbsp;Date <span class="rule" style="width:32mm">&nbsp;</span></div>
  </div>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to print this sheet.', 'error'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); }, 300);
  };

  const handleDiscard = () => {
    if (dirtyIds.size === 0) return;
    if (!window.confirm(`Discard ${dirtyIds.size} unsaved change(s)?`)) return;
    setQty({ ...initialQty });
    setCost({ ...initialCost });
    setBasePrices({ ...initialBase });
    setUnitPrices(JSON.parse(JSON.stringify(initialUnitPrices)));
  };

  if (!hasPermission('Items:Edit') && !hasPermission('OpeningBalance:Edit')) {
    return <div style={{ padding: 40 }}><h2>Access denied</h2><p>You don't have permission to set opening balances.</p></div>;
  }

  const declared = products.filter(p => num(initialQty[p.id]) > 0).length;
  const dupes    = products.filter(p => p._dupes > 1);

  const numInput = (value, onChange, opts = {}) => (
    <div style={{ position: 'relative' }}>
      {opts.prefix && (
        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: '#94a3b8', pointerEvents: 'none', fontWeight: 600 }}>{opts.prefix}</span>
      )}
      <input
        type="text" inputMode="decimal" value={value} onChange={e => onChange(e.target.value)}
        onFocus={opts.onFocus} onBlur={opts.onBlur} onWheel={e => e.target.blur()}
        placeholder={opts.placeholder || '0.00'}
        style={{
          width: '100%', padding: opts.prefix ? '11px 12px 11px 28px' : '11px 12px',
          borderRadius: 8, fontSize: 16, fontWeight: 700,
          border: `2px solid ${opts.border || '#e5e7eb'}`,
          background: opts.bg || '#fff', color: '#0f172a', outline: 'none',
          boxSizing: 'border-box', textAlign: 'right',
        }} />
    </div>
  );

  const label = (text, extra) => (
    <label style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span>{text}</span>{extra}
    </label>
  );

  return (
    <div className="page-content">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Opening Balance</h1>
          <p>
            What this branch holds, what it cost, what it sells for. An existing balance is <strong>replaced</strong>, not added to.
            {dirtyIds.size > 0 && <strong style={{ color: '#d97706' }}> {dirtyIds.size} unsaved change{dirtyIds.size > 1 ? 's' : ''}</strong>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handlePrintSheet} disabled={loading || products.length === 0}
            title={dirtyIds.size > 0 ? 'Save your changes first - the sheet prints what the database holds' : 'Print an A4 sheet to check stock and prices against the depot'}
            style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: loading || products.length === 0 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <FiPrinter size={14} /> Print Sheet
          </button>
          {dirtyIds.size > 0 && (
            <button onClick={handleDiscard} disabled={saving}
              style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <FiRefreshCw size={14} /> Discard
            </button>
          )}
          <button onClick={handleSaveAll} disabled={saving || dirtyIds.size === 0}
            style={{ padding: '10px 20px', borderRadius: 10, border: 'none', background: dirtyIds.size > 0 ? '#16a34a' : '#cbd5e1', color: '#fff', cursor: dirtyIds.size > 0 ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <FiSave size={15} /> {saving ? 'Savingâ€¦' : `Save All Changes${dirtyIds.size > 0 ? ` (${dirtyIds.size})` : ''}`}
          </button>
        </div>
      </div>

      {dupes.length > 0 && (
        <div style={{ margin: '10px 0', padding: '10px 14px', borderRadius: 10, background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e', fontSize: 12.5 }}>
          <strong>{dupes.length} item(s) carry more than one opening row</strong> â€” from before this page existed. The figure shown is their total.
          Saving that item keeps one row and retires the rest.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0 18px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '0 0 360px' }}>
          <FiSearch style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} size={15} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search product name or codeâ€¦"
            style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 10, border: '1.5px solid #e5e7eb', fontSize: 13, background: '#fff', outline: 'none' }} />
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#374151', cursor: 'pointer', fontWeight: 600 }}>
          <input type="checkbox" checked={onlyUnset} onChange={e => setOnlyUnset(e.target.checked)} />
          Only items with no balance yet
        </label>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {filteredProducts.length} of {products.length} products Â· <strong>{declared}</strong> already declared
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#94a3b8' }}>Loading items and balancesâ€¦</div>
      ) : filteredProducts.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', background: '#fff', borderRadius: 12 }}>No products match.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {filteredProducts.map(p => {
            const isDirty = dirtyIds.has(p.id);
            const dfltName = defaultUnitName(p);
            const baseUnitName = p._units[p._units.length - 1]?.name || '';
            const hadBalance = num(initialQty[p.id]) > 0;
            const qKey = `${p.id}:__qty`, cKey = `${p.id}:__cost`;
            return (
              <div key={p.id} style={{
                background: '#fff',
                border: `1.5px solid ${isDirty ? '#f59e0b' : '#e5e7eb'}`,
                borderRadius: 12, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              }}>
                <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px dashed #e5e7eb' }}>
                  <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 14, lineHeight: 1.2 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span>{p.code}</span>
                    {hadBalance && (
                      <span style={{ background: '#dcfce7', color: '#15803d', padding: '1px 6px', borderRadius: 4, fontSize: 9, letterSpacing: 0.4, fontWeight: 700 }}>
                        DECLARED {num(initialQty[p.id])}
                      </span>
                    )}
                    {p._dupes > 1 && (
                      <span style={{ background: '#fef3c7', color: '#b45309', padding: '1px 6px', borderRadius: 4, fontSize: 9, letterSpacing: 0.4, fontWeight: 700 }}>
                        {p._dupes} ROWS
                      </span>
                    )}
                    {isDirty && <span style={{ color: '#d97706', fontWeight: 700 }}>â— unsaved</span>}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <div style={{ flex: 1 }}>
                    {label(`Qty (${baseUnitName || 'base'})`,
                      <FiPackage size={11} style={{ color: '#94a3b8' }} />)}
                    {numInput(
                      editingKey === qKey ? editingRaw : (num(qty[p.id]) === 0 ? '' : String(num(qty[p.id]))),
                      (raw) => { setEditingKey(qKey); setEditingRaw(raw); setQty(prev => ({ ...prev, [p.id]: num(raw) })); },
                      {
                        placeholder: '0',
                        onFocus: () => { setEditingKey(qKey); setEditingRaw(num(qty[p.id]) === 0 ? '' : String(num(qty[p.id]))); },
                        onBlur:  () => { setEditingKey(null); setEditingRaw(''); },
                        border: isDirty ? '#f59e0b' : '#e5e7eb',
                        bg: isDirty ? '#fffbeb' : '#fff',
                      })}
                  </div>
                  <div style={{ flex: 1 }}>
                    {label('Cost')}
                    {numInput(
                      editingKey === cKey ? editingRaw : (num(cost[p.id]) === 0 ? '' : num(cost[p.id]).toFixed(2)),
                      (raw) => { setEditingKey(cKey); setEditingRaw(raw); setCost(prev => ({ ...prev, [p.id]: num(raw) })); },
                      {
                        prefix: curSym,
                        onFocus: () => { setEditingKey(cKey); setEditingRaw(num(cost[p.id]) === 0 ? '' : num(cost[p.id]).toFixed(2)); },
                        onBlur:  () => { setEditingKey(null); setEditingRaw(''); },
                        border: isDirty ? '#f59e0b' : '#e5e7eb',
                        bg: isDirty ? '#fffbeb' : '#fff',
                      })}
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
                          {label(
                            `${u.name}${u.is_base && num(u.conv) === 1 ? '' : ` (1 ${u.name} = ${u.conv} ${baseUnitName})`}`,
                            <>
                              {isDefault && (
                                <span style={{ background: '#dbeafe', color: '#1d4ed8', padding: '1px 6px', borderRadius: 4, fontSize: 9, letterSpacing: 0.4 }}>DEFAULT</span>
                              )}
                              {hasOverride && !isDefault && (
                                <span style={{ background: '#fef3c7', color: '#b45309', padding: '1px 6px', borderRadius: 4, fontSize: 9, letterSpacing: 0.4 }}>OVERRIDE</span>
                              )}
                            </>
                          )}
                          {numInput(displayValue, (raw) => handlePriceChange(p, u, raw), {
                            prefix: curSym,
                            onFocus: () => { setEditingKey(cellKey); setEditingRaw(displayValue); },
                            onBlur:  () => { setEditingKey(null); setEditingRaw(''); },
                            border: isDirty ? '#f59e0b' : (isDefault ? '#93c5fd' : '#e5e7eb'),
                            bg: isDirty ? '#fffbeb' : (isDefault ? '#eff6ff' : '#fff'),
                          })}
                        </div>
                        {!isLast && <div style={{ textAlign: 'center', color: '#cbd5e1', fontSize: 14, lineHeight: 1 }}>â†“</div>}
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

export default OpeningBalance;
