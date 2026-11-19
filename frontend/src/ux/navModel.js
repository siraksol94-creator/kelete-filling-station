// UX-6 — the side menu's brains, kept pure so CI can test them:
// which group a page belongs to, "Find a screen" matching (with everyday
// words: "dips" finds Tanks, "debtors" finds Account Receivables), and the
// short list of recently used screens.

// Which menu group holds a page (null = a top-level item).
export function groupForPath(path) {
  const p = String(path || '');
  if (p.startsWith('/fuel')) return 'fuel';
  if (p.startsWith('/pos') || /^\/hq\/(sales-report|route-sales|vat-report)/.test(p)) return 'pos';
  if (p.startsWith('/stock') || /^\/hq\/(inventory-report|purchases|confirm-grn|grn-archive|variances|confirm-damages|zra-purchases|zra-imports|products)/.test(p)) return 'stock';
  if (p.startsWith('/accounting') || /^\/hq\/(cash-position|consolidated-profit)/.test(p)) return 'accounting';
  if (p.startsWith('/suppliers-customers') || p.startsWith('/hq/suppliers')) return 'suppliersCustomers';
  if (p.startsWith('/settings') || p.startsWith('/setup')) return 'settings';
  return null;
}

// Everyday words people type for a screen (lower case). Keys are menu labels.
export const KEYWORDS = {
  'attendant shifts': 'shift meters readings attendants open close pump',
  'fuel cash report': 'cash variance short over banking takings',
  'credit sales': 'fuel credit tickets fleet account',
  '1card sales': 'onecard card fleet',
  'fuel deliveries': 'delivery tanker offload receive fuel',
  'tanks': 'dips dip levels ledger stock fuel litres',
  'pumps & nozzles': 'pump nozzle meters dispensers',
  'fuel grades': 'prices price petrol diesel paraffin',
  'pos': 'till sell sale point of sale shop',
  'sales report': 'sales takings daily report',
  'cash report': 'cash takings banking',
  'item details': 'products items prices barcode',
  'quick price': 'price change prices',
  'grn': 'goods received receive stock purchase delivery',
  'siv': 'stock issue issue voucher',
  'inventory': 'stock levels on hand',
  'bin card': 'stock movements history',
  'stock adjustment': 'adjust correct stock write off',
  'stock count': 'count stocktake',
  'expiry report': 'expired expiring dates',
  'cash receipt': 'receive money receipt income',
  'payment voucher': 'pay payment expense pv',
  'cash book': 'cash book money in out',
  'account payables': 'creditors owe suppliers bills ap',
  'account receivables': 'debtors owed credit customers ar',
  'profit report': 'profit loss p&l margin',
  'currency rates': 'exchange fx usd rate',
  'customers': 'clients fleet customer accounts',
  'suppliers': 'vendors supplier',
  'users': 'staff passwords roles permissions login',
  'profile': 'business email name address',
  'backups': 'backup restore',
  'messages': 'chat inbox',
  'dashboard': 'home overview today',
  'hq overview': 'branches group head office',
};

const norm = (s) => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Does this menu item match what was typed? Every typed word must appear in
// the label, its group, or its everyday words (start of a word counts).
export function matches(label, group, query) {
  const q = norm(query);
  if (!q) return true;
  const hay = ` ${norm(label)} ${norm(group)} ${KEYWORDS[norm(label)] || ''} `;
  return q.split(' ').every((w) => hay.includes(` ${w}`) || (w.length >= 3 && hay.includes(w)));
}

// Recently used screens: newest first, no repeats, at most `max`.
export function pushRecent(list, item, max = 4) {
  if (!item || !item.path || !item.label) return list || [];
  return [item, ...(list || []).filter((x) => x && x.path !== item.path)].slice(0, max);
}

export const recentKey = (userId) => `kelete.menu.recent.${userId || 'anon'}`;
export function loadRecent(store, userId) {
  try { const v = JSON.parse(store.getItem(recentKey(userId)) || '[]'); return Array.isArray(v) ? v.filter((x) => x && x.path && x.label).slice(0, 4) : []; }
  catch (_) { return []; }
}
export function saveRecent(store, userId, list) {
  try { store.setItem(recentKey(userId), JSON.stringify(list)); } catch (_) { /* private mode etc. */ }
}
