import React, { useMemo } from 'react';
import { FiLayers, FiTag } from 'react-icons/fi';

/**
 * Reusable Main Category + Category checkbox filter with smart cascading.
 *
 * Props:
 *   categories       - array of { id, name, color, main_category_id }
 *   mainCategories   - array of { id, name, color }
 *   selectedMainIds  - array of main category IDs currently checked (default: all)
 *   selectedCatIds   - array of category IDs currently checked (default: all)
 *   onChange         - ({ mainIds, catIds }) => void  — fires on any change
 *   compact          - bool — render in a more compact horizontal layout
 *
 * Behavior:
 *   - Checking/unchecking a main category checks/unchecks all its child categories
 *   - Categories list only shows children of currently-checked main categories
 *   - "Unassigned" virtual main category groups categories with main_category_id = null
 */
const CategoryFilter = ({
  categories = [],
  mainCategories = [],
  selectedMainIds = null,
  selectedCatIds = null,
  onChange,
  compact = false,
}) => {
  // Build the effective main category list (real ones + a virtual "Unassigned" if any cats lack a main)
  const hasUnassigned = useMemo(
    () => categories.some(c => !c.main_category_id),
    [categories]
  );
  const effectiveMains = useMemo(() => {
    const list = mainCategories.map(m => ({ ...m, _virtual: false }));
    if (hasUnassigned) list.push({ id: '__unassigned__', name: 'Uncategorized', color: '#6b7280', _virtual: true });
    return list;
  }, [mainCategories, hasUnassigned]);

  // Default selections: everything checked
  const mainIds = selectedMainIds ?? effectiveMains.map(m => m.id);
  const catIds  = selectedCatIds ?? categories.map(c => c.id);

  const isMainChecked = (id) => mainIds.includes(id);
  const isCatChecked  = (id) => catIds.includes(id);

  const catsForMain = (mainId) => {
    if (mainId === '__unassigned__') return categories.filter(c => !c.main_category_id);
    return categories.filter(c => String(c.main_category_id) === String(mainId));
  };

  // Visible categories = those whose main is currently checked
  const visibleCats = useMemo(() => {
    return categories.filter(c => {
      const mid = c.main_category_id ? c.main_category_id : '__unassigned__';
      return mainIds.some(id => String(id) === String(mid));
    });
  }, [categories, mainIds]);

  const toggleMain = (mainId) => {
    const childIds = catsForMain(mainId).map(c => c.id);
    let newMains, newCats;
    if (isMainChecked(mainId)) {
      // Uncheck main + uncheck all its children
      newMains = mainIds.filter(id => String(id) !== String(mainId));
      newCats  = catIds.filter(id => !childIds.some(cid => String(cid) === String(id)));
    } else {
      // Check main + check all its children
      newMains = [...mainIds, mainId];
      newCats  = Array.from(new Set([...catIds, ...childIds]));
    }
    onChange?.({ mainIds: newMains, catIds: newCats });
  };

  const toggleCat = (catId) => {
    let newCats;
    if (isCatChecked(catId)) {
      newCats = catIds.filter(id => String(id) !== String(catId));
    } else {
      newCats = [...catIds, catId];
    }
    onChange?.({ mainIds, catIds: newCats });
  };

  const allOn = () => {
    onChange?.({
      mainIds: effectiveMains.map(m => m.id),
      catIds: categories.map(c => c.id),
    });
  };
  const allOff = () => {
    onChange?.({ mainIds: [], catIds: [] });
  };

  const chip = (label, color, checked, onClick, key, icon) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 12px', borderRadius: 50,
        background: checked ? (color + '20') : '#f3f4f6',
        color: checked ? color : '#9ca3af',
        border: `1.5px solid ${checked ? (color + '50') : '#e5e7eb'}`,
        fontWeight: 600, fontSize: 12, cursor: 'pointer',
        transition: 'all 0.12s',
        textDecoration: checked ? 'none' : 'line-through',
        opacity: checked ? 1 : 0.7,
      }}
    >
      {icon}
      {label}
    </button>
  );

  return (
    // 2026-09-12 — cat-filter / cat-filter-row: on phones each chip row
    // scrolls sideways instead of wrapping down the screen (index.css).
    <div className="cat-filter" style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
      padding: compact ? '10px 14px' : '14px 18px',
      marginBottom: 16,
    }}>
      <div className="cat-filter-row" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 4 }}>
          <FiLayers size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Main Category:
        </span>
        {effectiveMains.length === 0 ? (
          <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>(none configured)</span>
        ) : effectiveMains.map(m =>
          chip(m.name, m.color || '#6b7280', isMainChecked(m.id), () => toggleMain(m.id), `m-${m.id}`)
        )}
        {effectiveMains.length > 0 && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" onClick={allOn}
              style={{ fontSize: 11, padding: '3px 10px', background: 'transparent', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', color: '#6b7280' }}>All</button>
            <button type="button" onClick={allOff}
              style={{ fontSize: 11, padding: '3px 10px', background: 'transparent', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', color: '#6b7280' }}>None</button>
          </span>
        )}
      </div>

      {visibleCats.length > 0 && (
        <div className="cat-filter-row" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', borderTop: '1px dashed #e5e7eb', paddingTop: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 4 }}>
            <FiTag size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Category:
          </span>
          {visibleCats.map(c =>
            chip(c.name, c.color || '#6b7280', isCatChecked(c.id), () => toggleCat(c.id), `c-${c.id}`)
          )}
        </div>
      )}
    </div>
  );
};

export default CategoryFilter;
