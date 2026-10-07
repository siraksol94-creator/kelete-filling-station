import React, { useState, useEffect } from 'react';
import { getStoreInventory, getSalesStockCard, getCategories, getMainCategories } from '../services/api';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiSearch, FiDownload, FiPackage, FiAlertTriangle, FiTrendingUp, FiGrid, FiPrinter } from 'react-icons/fi';
import CategoryFilter from '../components/CategoryFilter';
// formatStock / formatStockForProduct no longer used â€” all columns now use
// displayInDefaultUnit so qty + unit are consistent (incl. negatives).
import { displayInDefaultUnit } from '../utils/productUnits';
import printHtml from '../utils/printHtml';
import { matchTokens } from '../utils/tokenSearch';

const getCategoryClass = (cat) => {
  const map = { 'Beef': 'category-beef', 'Chicken': 'category-chicken', 'Pork': 'category-pork', 'Lamb': 'category-lamb', 'Processed': 'category-processed' };
  return map[cat] || 'badge-gray';
};

const getStockStatus = (balance, min) => {
  if (balance <= min * 0.5) return { label: 'Low', class: 'stock-low' };
  if (balance <= min * 1.2) return { label: 'Medium', class: 'stock-medium' };
  return { label: 'Good', class: 'stock-good' };
};

const todayStr = new Date().toISOString().split('T')[0];

const Inventory = ({ viewLocation = 'store' }) => {
  const { t } = useLanguage();
  const isSalesView = viewLocation === 'sales';
  const fetchFn = isSalesView ? getSalesStockCard : getStoreInventory;
  const titleText = isSalesView ? 'Sales Stock Card' : 'Stock Card';
  const subtitleText = isSalesView ? 'Stock levels at the sales counter (SIV in, sales out)' : 'Stock levels in the store (GRN in, SIV out)';
  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All Items');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Category filter state
  const [allCats, setAllCats] = useState([]);
  const [allMains, setAllMains] = useState([]);
  const [selMainIds, setSelMainIds] = useState(null);  // null = all selected (default)
  const [selCatIds,  setSelCatIds]  = useState(null);  // null = all selected (default)

  const fetchItems = async (f, t2) => {
    try {
      const params = {};
      if (f)  params.from = f;
      if (t2) params.to   = t2;
      const res = await fetchFn(params);
      // v1.6.3: hide inactive items from operational pages.
      const live = (res.data || []).filter(p => (p.status || 'Active') !== 'Inactive');
      setItems(live);
    } catch (err) { /* keep empty */ }
  };

  useEffect(() => {
    fetchItems('', '');
    getCategories().then(r => setAllCats(r.data || [])).catch(() => {});
    getMainCategories().then(r => setAllMains(r.data || [])).catch(() => {});
    const handler = () => fetchItems(from, to);
    window.addEventListener('sync-complete', handler);
    return () => window.removeEventListener('sync-complete', handler);
  }, []);

  const handleApply = () => fetchItems(from, to);

  const handleClear = () => {
    setFrom(''); setTo(''); setSearch(''); setFilter('All Items');
    setSelMainIds(null); setSelCatIds(null);
    fetchItems('', '');
  };

  // Active set of selected category IDs (null = all)
  const activeCatIds = selCatIds === null ? null : new Set(selCatIds.map(String));

  const filtered = items.filter(i => {
    const matchSearch = matchTokens(search, i.name, i.code, i.barcode);
    const matchCat = activeCatIds === null
      ? true
      : i.category_id ? activeCatIds.has(String(i.category_id)) : false;
    if (filter === 'Low Stock') return matchSearch && matchCat && parseFloat(i.store_balance) <= parseFloat(i.min_stock || 0);
    return matchSearch && matchCat;
  });

  // Stats follow the filter
  const totalItems = filtered.length;
  const lowStockCount = filtered.filter(i => parseFloat(i.store_balance) <= parseFloat(i.min_stock || 0)).length;
  // v1.13.83 â€” BALANCE VALUE = qty Ã— WAC (cost basis), not qty Ã— selling_price.
  // Old code showed "what we'd sell it for", but every stock report expects
  // "what we paid for it" so it reconciles with COGS + AP. avg_cost_price is
  // the stored WAC; fall back to the static cost_price hint if unset.
  const totalValue = filtered.reduce((sum, i) => sum + parseFloat(i.store_balance) * parseFloat(i.avg_cost_price || i.cost_price || 0), 0);
  const categories = [...new Set(filtered.map(i => i.category_name))].filter(Boolean).length;

  // Subtotals by main category
  const subtotalsByMain = (() => {
    const map = new Map(); // main_id â†’ { name, color, value, items }
    for (const item of filtered) {
      const mainId = item.main_category_id || '__unassigned__';
      const main = allMains.find(m => String(m.id) === String(item.main_category_id));
      const name = main ? main.name : 'Uncategorized';
      const color = main ? main.color : '#6b7280';
      if (!map.has(mainId)) map.set(mainId, { name, color, value: 0, items: 0 });
      const entry = map.get(mainId);
      entry.value += parseFloat(item.store_balance) * parseFloat(item.avg_cost_price || item.cost_price || 0);
      entry.items += 1;
    }
    return Array.from(map.values()).sort((a, b) => b.value - a.value);
  })();

  // Open a printable A4 page mirroring the current filtered table (status pills
  // and quantity units preserved). Uses the same `filtered` array that drives
  // the on-screen view so the printout reflects the active filter/search.
  const handlePrint = () => {
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const rows = filtered.map(item => {
      const storeBalance = parseFloat(item.store_balance);
      const stockStatus = getStockStatus(storeBalance, parseFloat(item.min_stock || 0));
      const value = storeBalance * parseFloat(item.avg_cost_price || item.cost_price || 0);
      const openDisp = displayInDefaultUnit(parseFloat(item.opening_balance || 0), item);
      const inDisp   = displayInDefaultUnit(parseFloat(item.total_in || 0), item);
      const outDisp  = displayInDefaultUnit(parseFloat(item.total_out || 0), item);
      const balDisp  = displayInDefaultUnit(storeBalance, item);
      const minDisp  = displayInDefaultUnit(parseFloat(item.min_stock || 0), item);
      return `<tr>
        <td>${esc(item.code)}</td>
        <td>${esc(item.name)}</td>
        <td>${esc(item.category_name || '')}</td>
        <td class="r">${openDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${esc(openDisp.unit)}</td>
        <td class="r" style="color:#16a34a">${inDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${esc(inDisp.unit)}</td>
        <td class="r" style="color:#dc2626">${outDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${esc(outDisp.unit)}</td>
        <td class="r"${storeBalance < 0 ? ' style="color:#dc2626;font-weight:600"' : ''}>${balDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${esc(balDisp.unit)}</td>
        <td class="r">${minDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${esc(minDisp.unit)}</td>
        <td class="r">${curSym}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td>${esc(stockStatus.label)}</td>
      </tr>`;
    }).join('');
    const filterLine = [
      search && `Search: "${search}"`,
      filter && filter !== 'All Items' && `Filter: ${filter}`,
      from && `From: ${from}`,
      to && `To: ${to}`,
    ].filter(Boolean).join(' Â· ') || 'All items';
    const printedAt = new Date().toLocaleString();
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(titleText)}</title>
      <style>
        @page { size: A4 landscape; margin: 8mm; }
        body { font-family: Arial, sans-serif; color: #111827; font-size: 11px; }
        h1 { font-size: 18px; margin: 0; }
        .meta { font-size: 10px; color: #6b7280; margin: 4px 0 10px; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #f3f4f6; text-align: left; padding: 6px 8px; border-bottom: 1px solid #d1d5db; font-size: 10px; }
        td { padding: 5px 8px; border-bottom: 1px solid #f3f4f6; }
        td.r { text-align: right; }
        tr:nth-child(even) td { background: #fafafa; }
        .footer { margin-top: 10px; font-size: 9px; color: #9ca3af; display: flex; justify-content: space-between; }
      </style>
      </head><body>
        <h1>${esc(titleText)}</h1>
        <div class="meta">${esc(subtitleText)} Â· ${esc(filterLine)} Â· ${filtered.length} item${filtered.length === 1 ? '' : 's'}</div>
        <table>
          <thead><tr><th>${esc(t('code'))}</th><th>${esc(t('product'))}</th><th>${esc(t('category'))}</th><th class="r">${esc(t('openingBalance'))}</th><th class="r">${esc(t('totalIn'))}</th><th class="r">${esc(t('totalOut'))}</th><th class="r">${esc(t('storeBalance'))}</th><th class="r">${esc(t('minStock'))}</th><th class="r">${esc(t('balanceValue'))}</th><th>${esc(t('status'))}</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="10" style="text-align:center;padding:20px;color:#9ca3af">No items</td></tr>'}</tbody>
        </table>
        <div class="footer"><span>${esc(titleText)}</span><span>Printed: ${esc(printedAt)}</span></div>
      </body></html>`;
    printHtml(html);
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{isSalesView ? titleText : t('inventoryTitle')}</h1>
          <p>{isSalesView ? subtitleText : t('inventorySubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={handlePrint}><FiPrinter /> Print</button>
          <button className="btn btn-primary"><FiDownload /> {t('exportReport')}</button>
        </div>
      </div>

      <div className="stat-cards">
        <div className="stat-card blue">
          <div className="stat-icon"><FiPackage /></div>
          <div><div className="stat-label">{t('totalItems')}</div><div className="stat-value">{hasPermission('Inventory:View') ? totalItems : 'N/A'}</div></div>
        </div>
        <div className="stat-card orange">
          <div className="stat-icon"><FiAlertTriangle /></div>
          <div><div className="stat-label">{t('lowStock')}</div><div className="stat-value">{hasPermission('Inventory:View') ? lowStockCount : 'N/A'}</div></div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><FiTrendingUp /></div>
          <div><div className="stat-label">{t('storeBalance')}</div><div className="stat-value">{hasPermission('Inventory:View') ? `${curSym}${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A'}</div></div>
        </div>
        <div className="stat-card purple">
          <div className="stat-icon"><FiGrid /></div>
          <div><div className="stat-label">{t('categories')}</div><div className="stat-value">{hasPermission('Inventory:View') ? categories : 'N/A'}</div></div>
        </div>
      </div>

      <CategoryFilter
        categories={allCats}
        mainCategories={allMains}
        selectedMainIds={selMainIds}
        selectedCatIds={selCatIds}
        onChange={({ mainIds, catIds }) => { setSelMainIds(mainIds); setSelCatIds(catIds); }}
      />

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="search-input-container" style={{ flex: '2 1 200px', marginBottom: 0 }}>
          <FiSearch style={{ color: '#9ca3af' }} />
          <input type="text" placeholder={t('searchByProductOrCode')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="filter-select" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="All Items">{t('allItems')}</option>
          <option value="Low Stock">{t('lowStock')}</option>
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{t('from')}</label>
          <input type="date" value={from} max={to || todayStr} onChange={e => setFrom(e.target.value)}
            style={{ padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{t('to')}</label>
          <input type="date" value={to} min={from || undefined} max={todayStr} onChange={e => setTo(e.target.value)}
            style={{ padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 }} />
        </div>
        <button onClick={handleApply}
          style={{ padding: '8px 18px', background: '#166534', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {t('apply')}
        </button>
        {(from || to || selMainIds !== null || selCatIds !== null || search || filter !== 'All Items') && (
          <button onClick={handleClear}
            style={{ padding: '8px 14px', background: '#fff', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>
            {t('clear')}
          </button>
        )}
      </div>

      {subtotalsByMain.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {subtotalsByMain.map(s => (
            <div key={s.name} style={{
              padding: '6px 12px', borderRadius: 8,
              background: (s.color || '#6b7280') + '15',
              border: `1px solid ${(s.color || '#6b7280')}40`,
              fontSize: 12,
            }}>
              <span style={{ color: s.color, fontWeight: 700 }}>{s.name}:</span>
              <span style={{ marginLeft: 6, color: '#374151', fontWeight: 600 }}>
                {s.items} item{s.items !== 1 ? 's' : ''} Â· {curSym}{s.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              {/* v1.9.24 â€” On the Sales Stock Card variant (viewLocation='sales')
                  the balance is the sales-floor balance, not a "store" balance
                  (Kelete has no store layer). Show a clearer label. */}
              <th>{t('code')}</th><th>{t('product')}</th><th>{t('category')}</th><th>{t('openingBalance')}</th><th>{t('totalIn')}</th><th>{t('totalOut')}</th>
              {isSalesView && (
                <th style={{ color: '#0e7490' }} title="PENDING outgoing inter-branch transfers (base units). Already dispatched but receiver hasn't confirmed yet.">Transit</th>
              )}
              <th>{isSalesView ? 'Stock Balance' : t('storeBalance')}</th><th>{t('minStock')}</th><th>{t('balanceValue')}</th><th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={isSalesView ? 11 : 10} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>{t('noData')}</td></tr>
            ) : filtered.map(item => {
              const storeBalance = parseFloat(item.store_balance);
              const openingBalance = parseFloat(item.opening_balance || 0);
              const totalIn = parseFloat(item.total_in || 0);
              const totalOut = parseFloat(item.total_out || 0);
              const transitQty = parseFloat(item.transit_qty || 0);
              const stockStatus = getStockStatus(storeBalance, parseFloat(item.min_stock || 0));
              const value = storeBalance * parseFloat(item.avg_cost_price || item.cost_price || 0);
              const openDisp = displayInDefaultUnit(openingBalance, item);
              const inDisp = displayInDefaultUnit(totalIn, item);
              const outDisp = displayInDefaultUnit(totalOut, item);
              const balDisp = displayInDefaultUnit(storeBalance, item);
              const transitDisp = displayInDefaultUnit(transitQty, item);
              const minDisp = displayInDefaultUnit(parseFloat(item.min_stock || 0), item);
              return (
                <tr key={item.id}>
                  <td style={{ fontWeight: 500 }}>{item.code}</td>
                  <td style={{ fontWeight: 500 }}>{item.name}</td>
                  <td><span className={`badge ${getCategoryClass(item.category_name)}`}>{item.category_name}</span></td>
                  <td>{openDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} {openDisp.unit}</td>
                  <td style={{ color: '#16a34a', fontWeight: 500 }}>{inDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} {inDisp.unit}</td>
                  <td style={{ color: '#dc2626', fontWeight: 500 }}>{outDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} {outDisp.unit}</td>
                  {isSalesView && (
                    <td style={{ color: transitQty > 0 ? '#0e7490' : '#9ca3af', fontWeight: transitQty > 0 ? 600 : 400 }}
                        title={transitQty > 0 ? 'PENDING outgoing transfers awaiting receiver confirmation' : undefined}>
                      {transitQty > 0
                        ? `${transitDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${transitDisp.unit}`
                        : 'â€”'}
                    </td>
                  )}
                  <td style={storeBalance < 0 ? { color: '#dc2626', fontWeight: 600 } : undefined}>
                    {balDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} {balDisp.unit}
                  </td>
                  <td>{minDisp.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} {minDisp.unit}</td>
                  <td>{curSym}{value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td><span className={stockStatus.class}>{stockStatus.label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Inventory;
