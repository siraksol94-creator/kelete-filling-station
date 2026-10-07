// Multi-unit conversion helper. Reads units_json off a product row (falls back to legacy
// alt_unit / conversion_factor) and returns the multiplier for converting a quantity entered
// in `lineUnit` into base units (i.e. into the smallest packaging â€” typically PCS for kelete).
//
// Usage:
//   const product = db.prepare('SELECT unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(id);
//   const baseQty = lineQty * conversionToBase(product, lineUnit);

function parseUnits(product) {
  if (!product) return null;
  if (product.units_json) {
    try { return JSON.parse(product.units_json); } catch { /* fall through */ }
  }
  return null;
}

function conversionToBase(product, lineUnit) {
  if (!product) return 1;
  const u = (lineUnit || '').toString().trim();
  if (!u) return 1;
  const ul = u.toLowerCase();
  // Base unit always converts 1:1.
  if (product.unit && product.unit.toLowerCase() === ul) return 1;
  const arr = parseUnits(product);
  if (arr) {
    const match = arr.find(x => (x.name || '').toLowerCase() === ul);
    if (match && parseFloat(match.conv) > 0) return parseFloat(match.conv);
  }
  // Legacy single-alt fallback.
  if (product.alt_unit && product.alt_unit.toLowerCase() === ul && parseFloat(product.conversion_factor) > 0) {
    return parseFloat(product.conversion_factor);
  }
  return 1;
}

// Build a SQL expression that converts a line quantity to BASE units, looking up the
// conversion factor in the product's units_json (so it handles N packagings, not just
// the legacy alt_unit). Falls back to alt_unit/conversion_factor for products that
// haven't been migrated yet, then to 1 if no match is found.
//
//   prodAlias â€” the SQL alias for the products row (e.g. 'p', 'gp', 'gip')
//   lineAlias â€” the SQL alias for the line item row (e.g. 'gi', 'oi')
//
// Use this anywhere a SUM(qty Ã— conversion) is computed in SQL.
function baseQtyExpr(prodAlias, lineAlias) {
  return `
    CASE
      WHEN ${lineAlias}.unit IS NULL OR ${lineAlias}.unit = ${prodAlias}.unit THEN ${lineAlias}.quantity
      ELSE ${lineAlias}.quantity * COALESCE(
        (SELECT json_extract(je.value, '$.conv')
         FROM json_each(${prodAlias}.units_json) je
         WHERE ${prodAlias}.units_json IS NOT NULL
           AND lower(json_extract(je.value, '$.name')) = lower(${lineAlias}.unit)
         LIMIT 1),
        CASE WHEN ${prodAlias}.alt_unit IS NOT NULL
              AND lower(${lineAlias}.unit) = lower(${prodAlias}.alt_unit)
             THEN ${prodAlias}.conversion_factor ELSE 1 END
      )
    END
  `;
}

module.exports = { parseUnits, conversionToBase, baseQtyExpr };
