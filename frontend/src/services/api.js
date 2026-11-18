import axios from 'axios';

const API_BASE_URL = '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' }
});

// HQ mode = the React app is being served from the bare keletezm.com (or
// localhost in dev) where there's no per-tenant subdomain. The branch
// is chosen by the user via a sidebar dropdown / login picker and
// stored in localStorage as 'hq.branch'. Every API call adds an
// X-Branch header so the backend routes to the right tenant DB
// (see backend/middleware/tenant.js — HQ branch-switch).
export const HQ_HOSTS = new Set(['keletezm.com', 'www.keletezm.com', 'localhost', '127.0.0.1']);
// Electron always runs on localhost but its identity is fixed at
// install-time (Setup screen) — it IS a branch, not HQ. Without this
// guard the localhost entry above made the login screen ask "pick a
// branch" + the sidebar surfaced HQ-only entries (HQ Products etc.)
// inside the desktop app. Detect Electron via its UA so dev `npm start`
// in a normal browser still gets HQ treatment.
export const isElectronUa = () => {
  try { return /electron/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || ''); }
  catch { return false; }
};
export const isHqHost = () => {
  try {
    if (isElectronUa()) return false;
    return HQ_HOSTS.has(window.location.hostname);
  } catch { return false; }
};
export const HQ_BRANCH_KEY = 'hq.branch';
export const getHqBranch = () => {
  try { return localStorage.getItem(HQ_BRANCH_KEY) || ''; }
  catch { return ''; }
};
export const setHqBranch = (slug) => {
  try {
    if (slug) localStorage.setItem(HQ_BRANCH_KEY, slug);
    else localStorage.removeItem(HQ_BRANCH_KEY);
  } catch { /* ignore */ }
};

// Electron-only: the branch slug this install belongs to. Cached at boot
// from /api/sync/status's vpsUrl. Used by pages that need to render or
// pass the slug client-side (e.g. Inter-Branch Transfers) since
// window.location.hostname is always "localhost" in Electron.
export const BRANCH_SLUG_KEY = 'branch.slug';
export const getBranchSlug = () => {
  try { return localStorage.getItem(BRANCH_SLUG_KEY) || ''; }
  catch { return ''; }
};
export const setBranchSlug = (slug) => {
  try {
    if (slug) localStorage.setItem(BRANCH_SLUG_KEY, slug);
    else localStorage.removeItem(BRANCH_SLUG_KEY);
  } catch { /* ignore */ }
};

// Add token + HQ branch header to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Only attach X-Branch when we're on the bare HQ host; sending it from
  // a real per-branch subdomain would be ignored by the backend, but
  // there's no reason to emit a header we don't need.
  if (isHqHost()) {
    const br = getHqBranch();
    if (br) config.headers['X-Branch'] = br;
  }
  return config;
});

// Auto-logout on 401 (expired/invalid token). Guard: if we're already on /login
// we mustn't hard-reload — that would loop indefinitely if a page-level effect keeps
// firing API calls on each mount.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// Auth
export const login = (data) => api.post('/auth/login', data);
export const register = (data) => api.post('/auth/register', data);
export const registerFirst = (data) => api.post('/auth/register-first', data);
export const verifyAdmin = (data) => api.post('/auth/verify-admin', data);
export const changePassword = (data) => api.post('/auth/change-password', data);

// In-app Messages (2026-09-14) — routes/chat.js.
export const getChatMe = () => api.get('/chat/me');
export const getChatPeople = () => api.get('/chat/people');
export const getChatConversations = () => api.get('/chat/conversations');
export const startDirectChat = (person) => api.post('/chat/conversations/direct', { person });
export const createChatGroup = (title, members) => api.post('/chat/conversations/group', { title, members });
export const updateChatMembers = (id, add, remove) => api.put(`/chat/conversations/${id}/members`, { add, remove });
export const getChatMessages = (id, params) => api.get(`/chat/conversations/${id}/messages`, { params });
export const sendChatMessage = (id, body, file) => {
  const form = new FormData();
  if (body) form.append('body', body);
  // The name carries the extension the server checks (voice notes are built in the browser).
  if (file) form.append('file', file, file.name || 'file');
  return api.post(`/chat/conversations/${id}/messages`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  });
};
export const deleteChatMessage = (id) => api.delete(`/chat/messages/${id}`);
export const markChatRead = (id, lastId) => api.post(`/chat/conversations/${id}/read`, { last_id: lastId });
export const getChatUnread = () => api.get('/chat/unread');
export const getChatFile = (messageId) => api.get(`/chat/files/${messageId}`, { responseType: 'blob', timeout: 60000 });

// Dashboard
export const getDashboard = () => api.get('/dashboard');

// Products
export const getProducts = (params) => api.get('/products', { params });
export const getProduct = (id) => api.get(`/products/${id}`);
export const getQuickItems = () => api.get('/products/quick-items');
// v1.8.34 — Quick Price Update bulk save.
export const bulkUpdatePrices = (updates) => api.post('/products/bulk-update-prices', { updates });
// v1.13.153 — Opening Balance page. The GET is what lets the page open
// pre-filled instead of blank, so an existing balance is typed over knowingly.
export const getOpeningBalances = () => api.get('/products/opening-balances');
export const saveOpeningBalances = (updates, password) =>
  api.post('/products/opening-balances', { updates, password });
export const bulkPushPrices = () => api.post('/products/bulk-push-prices');
// v1.13.154 — Branch Prices. HQ sets one branch's selling price without
// touching the others. Keyed on sync_id: product ids differ per database.
export const getBranchPrices  = (slug) => api.get(`/products/branch-prices/${slug}`);
// v1.13.155 — possible duplicate sales. dismissPossibleDuplicate records that
// a human judged a pair fine; it reverses and deletes nothing.
export const getPossibleDuplicates = (from, to) =>
  api.get('/orders/possible-duplicates', { params: { from, to } });
export const dismissPossibleDuplicate = (payload) =>
  api.post('/orders/possible-duplicates/dismiss', payload);
export const saveBranchPrices = (slug, updates) =>
  api.post(`/products/branch-prices/${slug}`, { updates });
// 2026-09-04 — scoped replacement for the hidden "Push Prices to All
// Branches": the items the operator just changed, to the depots they ticked.
export const multiPushBranchPrices = (updates, slugs) =>
  api.post('/products/branch-prices-multi-push', { updates, slugs });
// 2026-09-21 — cost price (C.P.): the OPENING cost, set at HQ and pushed to
// the depots chosen. Never the weighted average, which belongs to deliveries.
export const getCostPrices  = () => api.get('/products/cost-prices');
export const saveCostPrices = (updates) => api.post('/products/cost-prices', { updates });
export const pushCostPrices = (updates, slugs) =>
  api.post('/products/cost-prices-push', { updates, slugs });
export const addQuickItem = (product_sync_id) => api.post('/products/quick-items', { product_sync_id });
export const removeQuickItem = (productSyncId) => api.delete(`/products/quick-items/${productSyncId}`);
export const createProduct = (data) => api.post('/products', data);
export const updateProduct = (id, data) => api.put(`/products/${id}`, data);
export const updateProductBarcode = (id, data) => api.patch(`/products/${id}/barcode`, data);
export const deleteProduct = (id) => api.delete(`/products/${id}`);
export const deleteAllProducts = () => api.delete('/products/all');
// v1.8.1 — Transfer all store stock to sales floor as a single SIV.
// Password-gated server-side (must equal '108120').
export const bulkSivStoreToSales = (password) => api.post('/products/bulk-siv-store-to-sales', { password });

// v1.8.6 — Currency Exchanges (append-only ledger, scope='drawer'|'book').
export const getCurrencyExchanges = (params = {}) => api.get('/currency-exchanges', { params });
export const getCurrencyExchangesNet = (params = {}) => api.get('/currency-exchanges/net', { params });
export const createCurrencyExchange = (data) => api.post('/currency-exchanges', data);
export const importProducts = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/products/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
};
export const uploadProductImage = (id, file) => {
  const form = new FormData();
  form.append('image', file);
  return api.post(`/products/${id}/image`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
};
export const deleteProductImage = (id) => api.delete(`/products/${id}/image`);

// Generic invoice attachment (GRN / PV).
// `kind` is appended BEFORE `file` so multer's filename callback can read req.body.kind.
// Setting Content-Type to 'multipart/form-data' (no boundary) is the documented axios pattern —
// axios detects the FormData payload and replaces it with the boundary-augmented header.
export const uploadInvoiceAttachment = (file, kind) => {
  const form = new FormData();
  if (kind) form.append('kind', kind);
  form.append('file', file);
  return api.post('/attachments', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  });
};
export const deleteInvoiceAttachment = (path) => api.delete('/attachments', { params: { path } });

// Categories
export const getCategories = () => api.get('/categories');
export const createCategory = (data) => api.post('/categories', data);
export const updateCategory = (id, data) => api.put(`/categories/${id}`, data);
export const deleteCategory = (id) => api.delete(`/categories/${id}`);
export const deleteAllCategories = () => api.delete('/categories/all');

// Main Categories (groups categories under e.g. Whisky, Wine, Beer)
export const getMainCategories = () => api.get('/main-categories');
export const createMainCategory = (data) => api.post('/main-categories', data);
export const updateMainCategory = (id, data) => api.put(`/main-categories/${id}`, data);
export const deleteMainCategory = (id) => api.delete(`/main-categories/${id}`);

// Units (kg, pcs, Pack, etc.) — auto-imports existing product units on first load
export const getUnits = () => api.get('/units');
export const createUnit = (data) => api.post('/units', data);
export const updateUnit = (id, data) => api.put(`/units/${id}`, data);
export const deleteUnit = (id) => api.delete(`/units/${id}`);
export const importCategories = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/categories/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
};

// Orders
export const getOrders = () => api.get('/orders');
export const createOrder = (data) => api.post('/orders', data);
export const getOrder = (id) => api.get(`/orders/${id}`);
export const reverseOrder = (id, opts = {}) => {
  const body = {};
  if (opts.rfd_rsn_cd) body.rfd_rsn_cd = opts.rfd_rsn_cd;
  if (opts.rfd_rsn_other) body.rfd_rsn_other = opts.rfd_rsn_other;
  return api.put(`/orders/${id}/reverse`, body);
};
// v1.13.38 — Debit Note (ZRA checklist #21). Additional charge tied to
// an original invoice. Mirrors reverseOrder's shape.
// body: { amount, reason_cd: '01'..'07', notes? }
export const createDebitNote      = (orderId, data) => api.post(`/orders/${orderId}/debit-note`, data);
export const getOrderDebitNotes   = (orderId)       => api.get(`/orders/${orderId}/debit-notes`);
export const getDebitNotes        = (limit = 200)   => api.get('/orders/debit-notes/list', { params: { limit } });

// v1.13.62 — Customer empties deposit flow (LEGACY — superseded by
// bearer vouchers in v1.13.67; kept for pre-existing balance data).
export const getCustomerEmptyBalance   = (customerId)          => api.get(`/orders/customer-empties/${customerId}`);
export const getCustomerEmptyBalances  = ()                    => api.get('/orders/customer-empties');
export const createCustomerEmptyReturn = (data)                => api.post('/orders/customer-empties/pure-return', data);

// v1.13.67 — Empty voucher (bearer ticket) system.
//   listEmptyVouchers({status?, q?, limit?}) — Controller list view
//   getEmptyVoucher(codeOrId)                — POS lookup + history
//   createEmptyVoucher({qty, issued_to_name?, issued_to_phone?, notes?}) — Controller issues
//   voidEmptyVoucher(id, reason)             — admin void
export const listEmptyVouchers  = (params = {}) => api.get('/empty-vouchers', { params });
export const getEmptyVoucher    = (codeOrId)    => api.get(`/empty-vouchers/${encodeURIComponent(codeOrId)}`);
export const createEmptyVoucher = (data)        => api.post('/empty-vouchers', data);
export const voidEmptyVoucher   = (id, reason)  => api.put(`/empty-vouchers/${id}/void`, { reason });
export const getCashierInbox = () => api.get('/orders/cashier-inbox');
// v1.8.86 — read-only history of paid orders for the Cashier History tab.
export const getCashierPaymentHistory = (limit = 50) => api.get('/orders/payment-history', { params: { limit } });
export const collectOrderPayment = (id, data) => api.put(`/orders/${id}/collect-payment`, data);
// v1.8.87 — admin-only post-payment edit (typo/wrong-ccy/wrong-rate fix).
// 7-day window enforced server-side. Response includes cr_exists + cr_date +
// cr_cashier_name so the UI can nudge re-saving the day's Cash Report.
export const editOrderPayment = (id, data) => api.put(`/orders/${id}/edit-payment`, data);
export const getDispatchInbox = () => api.get('/orders/dispatch-inbox');
export const confirmDispatch = (id) => api.put(`/orders/${id}/confirm-dispatch`);

// HQ — public list of registered branches for the login + sidebar picker.
export const getHqBranches = () => api.get('/hq/branches');
// 2026-09-12 — every depot's PVs in one read-only list (HQ "All Depots" tab).
export const getHqPaymentVouchers = (params) => api.get('/hq/payment-vouchers', { params });
// 2026-09-17 — HQ Administrator deletes a depot's PV (in that depot's book).
export const deleteHqPaymentVoucher = (slug, id, reason) => api.delete(`/hq/payment-vouchers/${slug}/${id}`, { data: { reason } });
// 2026-09-18 — expenses over the depot's daily limit wait for HQ approval.
export const getExpenseRequests    = (params) => api.get('/payment-vouchers/expense-requests', { params });
export const createExpenseRequest  = (data)   => api.post('/payment-vouchers/expense-requests', data);
export const cancelExpenseRequest  = (syncId) => api.delete(`/payment-vouchers/expense-requests/${syncId}`);
export const getHqExpenseRequests  = (params) => api.get('/hq/expense-requests', { params });
export const getHqExpensePendingCount = () => api.get('/hq/expense-requests/pending-count');
export const getHqExpenseLimits    = () => api.get('/hq/expense-limits');
export const setHqExpenseLimit     = (slug, limit) => api.put(`/hq/expense-limits/${slug}`, { limit });
export const approveHqExpenseRequest = (slug, syncId) => api.post(`/hq/expense-requests/${slug}/${syncId}/approve`);
export const rejectHqExpenseRequest  = (slug, syncId, reason) => api.post(`/hq/expense-requests/${slug}/${syncId}/reject`, { reason });
// HQ — cross-branch summary (auth required). Backend loops over each
// tenant DB and aggregates today/MTD revenue, queue depths, stock value, AR.
export const getHqOverview = () => api.get('/hq/overview');
// HQ — cross-branch order list with date + branch filters. Defaults to
// today, all branches. Sorted newest first, capped at 1000 rows server-side.
export const getHqSalesReport = (params) => api.get('/hq/sales-report', { params });
export const getHqRouteSales = (params) => api.get('/hq/route-sales', { params });
// 2026-09-12 — consolidated VAT Transaction Report: { from, to, slug, cats }.
export const getHqVatReport = (params) => api.get('/hq/vat-report', { params });
// HQ — cross-branch stock list. Filters: branch, low_only, q (name search).
export const getHqInventoryReport = (params) => api.get('/hq/inventory-report', { params });
// HQ — per-branch cash IN/OUT/Net per method (Cash/Bank/MoMo), today + MTD.
// 2026-09-13 — { from, to, from_utc, to_utc }: a date range, not today/MTD both.
export const getHqCashPosition = (params) => api.get('/hq/cash-position', { params });
// HQ — Group net profit rolled up across every branch. K-only, no fx
// conversion. HQ overhead = SUM(payment_vouchers.amount).
export const getHqConsolidatedProfit = (params) => api.get('/hq/consolidated-profit', { params });

// HQ — v1.9.0 Layer 3: manual mirror of all HQ-owned entities (main_categories,
// categories, units, products) to every registered branch. Optional { slug }
// targets a single branch instead of all of them. Returns per-branch counts of
// inserted vs updated rows so the UI can show a results modal.
export const mirrorHqToAllBranches = (slug) =>
  api.post('/hq/mirror-all', slug ? { slug } : {});

// Sync — v1.9.4 trigger an immediate sync cycle on the local Electron backend.
// Used by the POS Change Price flow so the cashier doesn't wait up to 30s for
// the next scheduled push/pull. Harmless on web (returns triggered=false).
export const triggerSyncNow = () =>
  api.post('/sync/run-now').catch(() => null);

// v1.9.7 — Procurement Phase 2: branch can reject an incoming PO line.
// Reason is mandatory and shows on the HQ Purchases list so HQ can re-route
// the line to a different branch or cancel it.
export const branchRejectPoLine = (itemId, reason) =>
  api.put(`/hq/purchases/items/${itemId}/branch-reject`, { reason });
// 2026-08-31 — reject the WHOLE delivery. A truck arrives or it does not;
// declining one product and accepting the rest left a PO half-rejected and
// an invoice matching neither side.
export const branchRejectPo = (purchaseSyncId, reason, slug) =>
  api.put(`/hq/purchases/${purchaseSyncId}/branch-reject-all`, { reason, slug });

// v1.9.7 — HQ Confirm GRN flow. Lists every branch's GRNs sitting at
// hq_status='PENDING_HQ_CONFIRM'.
export const getAwaitingHqGrns = () => api.get('/hq/grns/awaiting');
// v1.9.14 — HQ-wide archive of CONFIRMED GRNs from master.db snapshot.
// params: { branch, supplier, from, to, limit }
export const getHqGrnArchive   = (params) => api.get('/hq/grns/archive', { params });
// Full GRN doc (header + items) by branch slug + GRN sync_id, for the
// review modal HQ opens before confirming.
export const getHqGrn      = (slug, syncId)         => api.get(`/hq/grns/${slug}/${syncId}`);
// v1.10.3 — Full doc for v1.10.0 HQ-generated GRNs (master.db only).
export const getHqGrnDetail = (syncId)              => api.get(`/hq/grns/hq/${syncId}`);
// 2026-09-17 — Void GRN (HQ Administrator).
export const voidHqGrn      = (syncId, reason)      => api.post(`/hq/grns/hq/${syncId}/void`, { reason });
// Confirm: posts stock at branch location='sales', flips PO lines to
// CONFIRMED, marks GRN hq_status='CONFIRMED'. Optional notes string.
export const confirmHqGrn  = (slug, syncId, notes)  => api.post(`/hq/grns/${slug}/${syncId}/confirm`, { notes: notes || null });
// Reject: branch can re-generate the GRN. Reason is mandatory.
export const rejectHqGrn   = (slug, syncId, reason) => api.post(`/hq/grns/${slug}/${syncId}/reject`, { reason });

// v1.13.30 — AP approval chain (HQ Store Manager → Accounts → Finance → Cashier).
export const getApApprovalQueue = (status)    => api.get('/hq/grns/ap/queue', { params: status ? { status } : {} });
// The Store Manager's delivery confirmation — the stage in front of the AP
// queue. The invoice scan is required here, not at the depot.
export const apPendingCredits = (grnSyncId) =>
  api.get(`/hq/grns/ap/${grnSyncId}/pending-credits`);
export const apConfirmDelivery = (grnSyncId, invoice_attachment) =>
  api.post(`/hq/grns/ap/${grnSyncId}/confirm-delivery`, { invoice_attachment });
export const apCheck            = (grnSyncId) => api.post(`/hq/grns/ap/${grnSyncId}/check`);
export const apApprove          = (grnSyncId) => api.post(`/hq/grns/ap/${grnSyncId}/approve`);
// Approve several GRNs of one supplier as a single payment batch. They then
// appear in Ready for Payment as one collapsible line.
export const apApproveBatch     = (grnSyncIds) => api.post('/hq/grns/ap/approve-batch', { grn_sync_ids: grnSyncIds });
// 2026-08-31 — Finance's per-GRN review. Approval itself stays a batch action;
// this only records that someone opened this one and agreed with it.
export const apConfirmReview   = (grnSyncId) => api.post(`/hq/grns/ap/${grnSyncId}/confirm-review`);
// 2026-08-31 — the same stages, for a standalone credit note. A credit that
// belongs to no invoice walks Awaiting Check -> Confirmation -> Ready for
// Payment and ends APPLIED, consumed against a payment rather than paid out.
// Checking a standalone credit is where it gets attached to a GRN — a person
// decides which invoice it belongs against, rather than a formula guessing.
export const apCheckCredit          = (syncId, grnSyncId) => api.post(`/hq/grns/ap/credit/${syncId}/check`, { grn_sync_id: grnSyncId });
export const apConfirmCredit        = (syncId) => api.post(`/hq/grns/ap/credit/${syncId}/confirm-review`);
export const apUnconfirmCredit      = (syncId) => api.post(`/hq/grns/ap/credit/${syncId}/unconfirm-review`);
export const apApproveCreditBatch   = (syncIds) => api.post('/hq/grns/ap/credit/approve-batch', { credit_sync_ids: syncIds });
export const apSendBackCredit       = (syncId, reason) => api.post(`/hq/grns/ap/credit/${syncId}/send-back`, { reason });
export const apUnconfirmReview = (grnSyncId) => api.post(`/hq/grns/ap/${grnSyncId}/unconfirm-review`);
// Backend still supports Send-Back but the UI doesn't expose it (per user
// choice v1.13.30 — Option A / no reject flow). Uncomment the row on the
// AP page + this helper to enable it later.
// 2026-08-30 — wired up at last. The endpoint has existed since the AP flow
// was built; the client call sat commented out, so there was no way to reject
// a GRN from the UI at all.
export const apSendBack       = (grnSyncId, reason) => api.post(`/hq/grns/ap/${grnSyncId}/send-back`, { reason });
export const getApRejectReasons = () => api.get('/hq/grns/ap/reject-reasons');

// v1.10.0 — new procurement flow: branch confirms received qty + invoice on
// the PO; HQ then generates the GRN. See backend/routes/branchReceipts.js
// + backend/routes/hqGrns.js (awaiting-generation / receipt / generate).
export const confirmBranchReceipt = (purchaseSyncId, payload) =>
  api.post(`/branch/po-receipts/${purchaseSyncId}/confirm`, payload);
export const getAwaitingGeneration = () => api.get('/hq/grns/awaiting-generation');
export const getHqReceipt          = (syncId) => api.get(`/hq/grns/receipt/${syncId}`);
export const generateHqGrn         = (payload) => api.post('/hq/grns/generate', payload);

// Stock Transfers (Phase C — HQ Warehouse). Stored in master.db so source
// + destination see the same row. Works the same on HQ and on per-branch
// subdomains; the "current branch" the page operates against is derived
// from either the HQ X-Branch header (if set) or the host's subdomain.
export const getTransferSourceProducts = (slug) => api.get('/transfers/source-products', { params: { slug } });
export const getOutgoingTransfers = (params) => api.get('/transfers/outgoing', { params });
export const getIncomingTransfers = (params) => api.get('/transfers/incoming', { params });
export const createTransfer = (data) => api.post('/transfers', data);
export const receiveTransfer = (id, data) => api.put(`/transfers/${id}/receive`, data || {});

// v1.8.65 — HQ Transit Variances (cross-source: Inter-Branch Transfers + HQ Purchases).
export const getHqVariances = (params) => api.get('/hq/variances', { params });
export const resolveTransferVariance = (syncId, data) => api.put(`/hq/variances/transfer/${syncId}/resolve`, data || {});
export const cancelTransfer = (id) => api.put(`/transfers/${id}/cancel`);

// v1.8.57 — Branch → HQ Cash Deposit workflow.
// Branch creates a PENDING deposit, HQ confirms (writes PV on branch + CR
// on HQ) or rejects (no ledger writes). Lives in master.db.
export const getCashDeposits   = (params) => api.get('/cash-deposits', { params });
export const getCashDepositTarget = (slug) => api.get('/cash-deposits/target', { params: { slug } });
export const createCashDeposit = (data)   => api.post('/cash-deposits', data);
export const confirmCashDeposit = (id, body) => api.put(`/cash-deposits/${id}/confirm`, body || {});
export const rejectCashDeposit  = (id, reason) => api.put(`/cash-deposits/${id}/reject`, { reason });
export const deleteCashDeposit  = (id, reason) => api.delete(`/cash-deposits/${id}`, { data: { reason } });
export const editCashDepositDate = (id, deposit_date) => api.put(`/cash-deposits/${id}/date`, { deposit_date });

// HQ Purchases — Phase C v2: supplier purchases logged at HQ with
// per-line destination branch. HQ has no warehouse / no source stock.
// Branch confirms with actual received qty; stock arrives in branch DB
// only on receive (auto-creates product if missing by sync_id or name).
export const getHqPurchases = (params) => api.get('/hq/purchases', { params });
// Product Received Breakdown on the GRN Archive — HQ twin of
// getGRNProductReport / getGRNProductBreakdown, over master.db's HQ GRNs.
export const getHqGrnProductReport    = (params) => api.get('/hq/grns/product-report', { params });
export const getHqGrnProductBreakdown = (params) => api.get('/hq/grns/product-breakdown', { params });
export const getHqPurchase = (id) => api.get(`/hq/purchases/${id}`);
export const createHqPurchase = (data) => api.post('/hq/purchases', data);
// 2026-09-09 — drafts. Pass status:'DRAFT' to park one, status:'OPEN' to
// raise it. Both go through the same routes a purchase does, so a draft
// promoted is byte-identical to one typed straight in.
export const saveHqPurchaseDraft   = (id, data) => api.put(`/hq/purchases/${id}`, data);
export const deleteHqPurchaseDraft = (id) => api.delete(`/hq/purchases/${id}`);
export const getHqPurchaseIncoming = (slug, scope = 'pending') => api.get('/hq/purchases/incoming', { params: { slug, scope } });
// v1.3.0 split: branch SUBMITS a GRN (status → GRN_SUBMITTED, no stock yet);
// HQ then CONFIRMS (stock + AP land) or REJECTS (back to AWAITING_GRN).
export const submitHqPurchaseGrn   = (itemId, data) => api.put(`/hq/purchases/items/${itemId}/submit-grn`, data);
export const confirmHqPurchaseItem = (itemId, data) => api.put(`/hq/purchases/items/${itemId}/confirm`, data);
export const rejectHqPurchaseItem  = (itemId, data) => api.put(`/hq/purchases/items/${itemId}/reject`, data);
export const getHqGrnAwaitingConfirmation = () => api.get('/hq/purchases/awaiting-confirmation');
// Legacy alias — older builds still call this; routes to submit-grn now.
export const receiveHqPurchaseItem = (itemId, data) => api.put(`/hq/purchases/items/${itemId}/submit-grn`, data);
export const cancelHqPurchaseItem  = (itemId) => api.put(`/hq/purchases/items/${itemId}/cancel`);
export const cancelHqPurchase      = (id) => api.put(`/hq/purchases/${id}/cancel`);

// Sidebar badge counts — one cheap call covers cashier / dispatch /
// incoming stock / incoming transfers for the current branch.
export const getNotificationBadges = (slug) => api.get('/notifications/badges', { params: { slug } });
// 2026-09-19 — 'hq' asks for HQ's own version: deliveries a depot has
// confirmed that are waiting in Generate GRN. Any other value is a depot's
// slug and returns what is coming TO that depot.
export const getIncomingNotice = (slug) => api.get('/notifications/incoming',
  { params: slug === 'hq' ? { scope: 'hq' } : { slug } });

// HQ Suppliers + AP — supplier master with live AP balance computed
// from purchases - payments (never stored).
export const getHqSuppliers = () => api.get('/hq/suppliers');
export const getHqSupplier  = (id) => api.get(`/hq/suppliers/${id}`);
export const createHqSupplier = (data) => api.post('/hq/suppliers', data);
export const updateHqSupplier = (id, data) => api.put(`/hq/suppliers/${id}`, data);
// Deleting a supplier needs an Administrator password, checked server-side.
export const deleteHqSupplier = (id, password) =>
  api.delete(`/hq/suppliers/${id}`, { data: { password } });
export const recordHqSupplierPayment = (supplierId, data) => api.post(`/hq/suppliers/${supplierId}/payments`, data);
export const deleteHqSupplierPayment = (paymentId) => api.delete(`/hq/suppliers/payments/${paymentId}`);

// HQ Damages — v1.3.1 cross-branch queue of branch-declared damages
// waiting for HQ to confirm before sales-floor stock is decremented.
export const getHqDamagesAwaiting = () => api.get('/hq/damages/awaiting');
export const confirmHqDamage = (slug, id, data) => api.put(`/hq/damages/${slug}/${id}/confirm`, data || {});
export const rejectHqDamage  = (slug, id, data) => api.put(`/hq/damages/${slug}/${id}/reject`,  data || {});

// HQ Products — central catalogue. HQ creates → auto-pushed to every
// branch (matched by sync_id). Branches keep their own selling price;
// pass override_prices=true on PUT to force-push HQ defaults onto
// branches that already had the product.
// What this item last cost from this supplier — prefills the purchase line.
export const getLastPurchasePrice = (product_sync_id, supplier_id) =>
  api.get('/hq/purchases/last-price', { params: { product_sync_id, supplier_id } });
// Where has a purchase got to? Searched by the supplier's invoice number
// first — that is the number Red Sea and its suppliers actually talk in —
// then by our PO or GRN number.
export const traceHqPurchase = (q) =>
  api.get('/hq/purchases/trace', { params: { q } });
export const getHqProducts = (params) => api.get('/hq/products', { params });
export const getHqProduct  = (id) => api.get(`/hq/products/${id}`);
export const createHqProduct = (data) => api.post('/hq/products', data);
// v1.5.0: override_prices param dropped — HQ never touches branch prices.
// Every save pushes HQ-owned columns only.
export const updateHqProduct = (id, data) => api.put(`/hq/products/${id}`, data);
export const deleteHqProduct = (id) => api.delete(`/hq/products/${id}`);
export const pushHqProduct   = (id) => api.post(`/hq/products/${id}/push`);
export const reverseOrderItem = (orderId, itemId, quantity, unit, opts = {}) => {
  const body = {};
  if (quantity != null) body.quantity = quantity;
  if (unit) body.unit = unit;
  if (opts.rfd_rsn_cd) body.rfd_rsn_cd = opts.rfd_rsn_cd;
  if (opts.rfd_rsn_other) body.rfd_rsn_other = opts.rfd_rsn_other;
  return api.put(`/orders/${orderId}/items/${itemId}/reverse`, body);
};

// ── Stock Reconciliation ────────────────────────────────────────────────────
export const getReconciliationProducts = (location, countDate) => {
  const params = new URLSearchParams({ location });
  if (countDate) params.set('count_date', countDate);
  return api.get(`/stock-reconciliation/products?${params.toString()}`);
};
export const getReconciliations = (location) => api.get(`/stock-reconciliation${location ? `?location=${location}` : ''}`);
export const getReconciliation = (id) => api.get(`/stock-reconciliation/${id}`);
export const createReconciliation = (data) => api.post('/stock-reconciliation', data);
export const deleteReconciliation = (id) => api.delete(`/stock-reconciliation/${id}`);
export const getOrderProductSummary = (from, to, userId) => api.get('/orders/product-summary', { params: { from, to, userId } });
export const getProductBreakdown = (productName, from, to, userId) => api.get('/orders/product-breakdown', { params: { productName, from, to, userId } });

// GRN
export const getGRNs = () => api.get('/grn');
export const getGRNStats = () => api.get('/grn/stats');
export const getGRNNotes = () => api.get('/grn/notes');
export const getGRNRecentProducts = () => api.get('/grn/recent-products');
export const createGRN = (data) => api.post('/grn', data);
export const getGRN = (id) => api.get(`/grn/${id}`);
export const getGRNProductReport = (params) => api.get('/grn/product-report', { params });
export const getGRNProductBreakdown = (params) => api.get('/grn/product-breakdown', { params });
export const updateGRN = (id, data) => api.put(`/grn/${id}`, data);
export const deleteGRN = (id) => api.delete(`/grn/${id}`);

// Empty Returns — sending crates/bottles back to supplier for a deposit credit.
export const getEmptyReturns      = () => api.get('/empty-returns');
export const getEmptyReturnStats  = () => api.get('/empty-returns/stats');
export const getEmptyReturn       = (id) => api.get(`/empty-returns/${id}`);
export const createEmptyReturn    = (data) => api.post('/empty-returns', data);
export const updateEmptyReturn    = (id, data) => api.put(`/empty-returns/${id}`, data);
export const deleteEmptyReturn    = (id) => api.delete(`/empty-returns/${id}`);

// Supplier Credit Notes — Discount / Crate Return / Bottle Return / Other.
// Reduce AP balance; Discount + Other feed Profit Report as Supplier Rebates.
export const getCreditNotes      = (params) => api.get('/credit-notes', { params });
export const getCreditNoteStats  = () => api.get('/credit-notes/stats');
// GRNs a credit note may still be attached to — this branch's, unpaid.
// HQ agreeing to a credit a depot raised — the only thing that reduces a payable.
export const confirmCreditNote   = (syncId) => api.post(`/credit-notes/${syncId}/confirm`);
export const getLinkableGrns     = (supplier_sync_id) =>
  api.get('/credit-notes/linkable-grns', { params: supplier_sync_id ? { supplier_sync_id } : {} });
// The chosen invoice's lines, and each item's price on the last invoice that
// delivered it — both VAT inclusive ÷ qty. Branch-scoped on a depot.
export const getCreditNoteGrnLines   = (grn_sync_id) =>
  api.get('/credit-notes/grn-lines', { params: { grn_sync_id } });
export const getCreditNoteLastPrices = (branch_slug) =>
  api.get('/credit-notes/last-invoice-prices', { params: branch_slug ? { branch_slug } : {} });
export const getCreditNote       = (id) => api.get(`/credit-notes/${id}`);
export const createCreditNote    = (data) => api.post('/credit-notes', data);
export const updateCreditNote    = (id, data) => api.put(`/credit-notes/${id}`, data);
export const deleteCreditNote    = (id) => api.delete(`/credit-notes/${id}`);

// Capital Account — owner equity ledger (Injection/Drawing)
export const getCapitalEntries   = (params) => api.get('/capital-account', { params });
export const getCapitalStats     = () => api.get('/capital-account/stats');
export const getCapitalEntry     = (id) => api.get(`/capital-account/${id}`);
export const createCapitalEntry  = (data) => api.post('/capital-account', data);
export const updateCapitalEntry  = (id, data) => api.put(`/capital-account/${id}`, data);
export const deleteCapitalEntry  = (id) => api.delete(`/capital-account/${id}`);

// Dividend Account — profit distribution to owner(s)
export const getDividendEntries  = (params) => api.get('/dividend-account', { params });
export const getDividendStats    = () => api.get('/dividend-account/stats');
export const getDividendEntry    = (id) => api.get(`/dividend-account/${id}`);
export const createDividendEntry = (data) => api.post('/dividend-account', data);
export const updateDividendEntry = (id, data) => api.put(`/dividend-account/${id}`, data);
export const deleteDividendEntry = (id) => api.delete(`/dividend-account/${id}`);

// Discount approval requests — cashier creates pending row, admin approves/rejects.
export const createDiscountRequest          = (data) => api.post('/discount-requests', data);
export const getDiscountRequest             = (syncId) => api.get(`/discount-requests/${syncId}`);
export const cancelDiscountRequest          = (syncId) => api.delete(`/discount-requests/${syncId}`);
export const getDiscountRequests            = (params) => api.get('/discount-requests', { params });
export const getDiscountRequestsPendingCount = () => api.get('/discount-requests/pending-count');
export const approveDiscountRequest         = (syncId) => api.put(`/discount-requests/${syncId}/approve`);
export const rejectDiscountRequest          = (syncId, reason) => api.put(`/discount-requests/${syncId}/reject`, { reason });

// Shareholders — master list of equity holders
export const getShareholders        = () => api.get('/shareholders');
export const getShareholderStats    = () => api.get('/shareholders/stats');
export const getShareholder         = (id) => api.get(`/shareholders/${id}`);
export const createShareholder      = (data) => api.post('/shareholders', data);
export const updateShareholder      = (id, data) => api.put(`/shareholders/${id}`, data);
export const deleteShareholder      = (id) => api.delete(`/shareholders/${id}`);

// Loans — liability sub-ledger (loans + per-loan transactions)
export const getLoans               = (params) => api.get('/loans', { params });
export const getLoanStats           = () => api.get('/loans/stats');
export const getLoan                = (id) => api.get(`/loans/${id}`);
export const createLoan             = (data) => api.post('/loans', data);
export const updateLoan             = (id, data) => api.put(`/loans/${id}`, data);
export const deleteLoan             = (id) => api.delete(`/loans/${id}`);
export const createLoanTransaction  = (loanId, data) => api.post(`/loans/${loanId}/transactions`, data);
export const updateLoanTransaction  = (loanId, txId, data) => api.put(`/loans/${loanId}/transactions/${txId}`, data);
export const deleteLoanTransaction  = (loanId, txId) => api.delete(`/loans/${loanId}/transactions/${txId}`);

// Inventory (two-location)
export const getInventory = () => api.get('/inventory');
export const getStoreInventory = (params) => api.get('/inventory/store', { params });
// Same shape as getStoreInventory, just filtered on the sales-counter side
// of the stock ledger — powers the Sales Stock Card page.
export const getSalesStockCard = (params) => api.get('/inventory/store', { params: { ...(params || {}), location: 'sales' } });
export const getSalesInventory = (params) => api.get('/inventory/sales', { params });
export const getSalesMonthlySummary = (month) => api.get('/inventory/sales/monthly-summary', { params: { month } });
export const getSalesProfitSummary = (date) => api.get('/inventory/sales/profit-summary', { params: { date } });
export const getSalesRangeSummary = (from, to) => api.get('/inventory/sales/range-summary', { params: { from, to } });
export const getSalesDailySummary = (date) => api.get('/inventory/sales/daily-summary', { params: { date } });
export const getSIVBreakdown = (date, product_id) => api.get('/inventory/sales/siv-breakdown', { params: { date, product_id } });
export const saveSalesActualBalance = (data) => api.post('/inventory/sales/actual', data);
export const getInventoryStats = () => api.get('/inventory/stats');
export const getBinCard = (params) => api.get('/inventory/bin-card', { params });
// 2026-08-30 — read-only HQ GRN behind a bin-card reference. Branch GRNs
// live in the branch DB; HQ-generated ones live in master.db, so the bin card
// opens a modal from this rather than linking to a page that has no such row.
export const getHqGrnForBranch = (syncId) => api.get(`/inventory/hq-grn/${encodeURIComponent(syncId)}`);
export const getSalesBinCard = (params) => api.get('/inventory/sales-bin-card', { params });
// v1.13.115 — ZRA Ref 9 VAT Transaction Report endpoint
export const getVatReport    = (params) => api.get('/orders/vat-report', { params });
// v1.13.124 — mark a CN as first-printed so subsequent prints get the COPY band
export const markCnPrinted   = (orderId) => api.put(`/orders/${orderId}/mark-cn-printed`);

// SIV
export const getSIVs = () => api.get('/siv');
export const getSIVStats = () => api.get('/siv/stats');
export const getSIVNotes = () => api.get('/siv/notes');
export const getSIVRecentProducts = () => api.get('/siv/recent-products');
export const getSIVItemsSummary = (from, to) => api.get('/siv/items-summary', { params: { from, to } });
export const createSIV = (data) => api.post('/siv', data);
export const getSIV = (id) => api.get(`/siv/${id}`);
export const updateSIV = (id, data) => api.put(`/siv/${id}`, data);
export const deleteSIV = (id) => api.delete(`/siv/${id}`);
export const getSIVItemBreakdown = (product_id, from, to) => api.get('/siv/item-breakdown', { params: { product_id, from, to } });

// Cash Receipts
export const getCashReceipts = () => api.get('/cash-receipts');
export const getCashReceiptStats = () => api.get('/cash-receipts/stats');
export const checkSalesCashReceipt = (date, received_from) => api.get('/cash-receipts/check-sales', { params: { date, received_from } });
export const createCashReceipt = (data) => api.post('/cash-receipts', data);
export const updateCashReceipt = (id, data) => api.put(`/cash-receipts/${id}`, data);
export const deleteCashReceipt = (id) => api.delete(`/cash-receipts/${id}`);

// v1.10.43 — fromUtc / toUtc: SQLite-format UTC datetime bounds
// corresponding to the LOCAL day. Same shape /cash-reports/daily accepts.
// When both are provided the backend uses them and ignores date/from/to.
export const getSalesCashiers = (date, from, to, fromUtc, toUtc) => {
  const params = {};
  if (date)    params.date     = date;
  if (from)    params.from     = from;
  if (to)      params.to       = to;
  if (fromUtc) params.from_utc = fromUtc;
  if (toUtc)   params.to_utc   = toUtc;
  return api.get('/cash-reports/sales-cashiers', { params });
};
// v1.10.9 — admin-gated delete of a saved cash report row.
export const deleteCashReport = (id) => api.delete(`/cash-reports/${id}`);

// Payment Vouchers
export const getPaymentVouchers = (params) => api.get('/payment-vouchers', { params });
export const getPaymentVoucherStats = () => api.get('/payment-vouchers/stats');
export const createPaymentVoucher = (data) => api.post('/payment-vouchers', data);
export const updatePaymentVoucher = (id, data) => api.put(`/payment-vouchers/${id}`, data);
export const deletePaymentVoucher = (id) => api.delete(`/payment-vouchers/${id}`);

// PV Types
export const getPvTypes = () => api.get('/pv-types');
export const createPvType = (data) => api.post('/pv-types', data);
export const updatePvType = (id, data) => api.put(`/pv-types/${id}`, data);
export const deletePvType = (id) => api.delete(`/pv-types/${id}`);

// Cash Book
export const getCashBook = (params) => api.get('/cash-book', { params });
export const getCashBookStats = (params) => api.get('/cash-book/stats', { params });
// Accepts either a single number (legacy: sets Cash opening) OR an object { cash, bank, momo }.
// Opening balances move every running balance in the Cash Book, so the route
// requires an Administrator password.
export const setOpeningBalance = (data, password) =>
  api.post('/cash-book/opening-balance',
    typeof data === 'object' ? { ...data, password } : { amount: data, password });
// Cash transfers — moves money between methods (Cash <-> Bank <-> Mobile Money)
export const getCashTransfers = () => api.get('/cash-book/transfers');
export const createCashTransfer = (data) => api.post('/cash-book/transfers', data);
export const deleteCashTransfer = (id) => api.delete(`/cash-book/transfers/${id}`);

// Account Payables
export const getAccountPayables = (params) => api.get('/account-payables', { params });
export const getSupplierBreakdown = (supplierId) => api.get(`/account-payables/breakdown/${supplierId}`);
export const createApPayment = (data) => api.post('/ap-payments', data);
// One payment settling several GRNs of the SAME supplier. The server allocates
// oldest-GRN-first and refuses overpayment; see routes/apPayments.js /batch.
export const createApPaymentBatch = (data) => api.post('/ap-payments/batch', data);
export const getApPayments = (params) => api.get('/ap-payments', { params });
export const updateApPayment = (id, data) => api.put(`/ap-payments/${id}`, data);
export const deleteApPayment = (id) => api.delete(`/ap-payments/${id}`);
export const getAccountPayableStats = (params) => api.get('/account-payables/stats', { params });
export const createAccountPayable = (data) => api.post('/account-payables', data);
export const payInvoice = (id, data) => api.put(`/account-payables/${id}/pay`, data);

// Suppliers
export const getSuppliers = () => api.get('/suppliers');
export const getSupplierStats = () => api.get('/suppliers/stats');
export const createSupplier = (data) => api.post('/suppliers', data);
export const updateSupplier = (id, data) => api.put(`/suppliers/${id}`, data);
export const deleteSupplier = (id) => api.delete(`/suppliers/${id}`);

// Customers
export const getCustomers = (params) => api.get('/customers', { params });
export const getCustomerStats = () => api.get('/customers/stats');
export const createCustomer = (data) => api.post('/customers', data);
export const updateCustomer = (id, data) => api.put(`/customers/${id}`, data);
export const deleteCustomer = (id, { cascadePayments = false } = {}) =>
  api.delete(`/customers/${id}${cascadePayments ? '?cascade=payments' : ''}`);
export const getCustomerStatement = (id) => api.get(`/customers/${id}/statement`);
export const getCustomerAging = () => api.get('/customers/aging');
export const getArStats = (params) => api.get('/customers/ar-stats', { params });
export const getCustomerInsights = (id) => api.get(`/customers/${id}/insights`);
export const getOrphanOrders = (id) => api.get(`/customers/${id}/orphan-orders`);
export const claimOrphanOrders = (id) => api.post(`/customers/${id}/claim-orphan-orders`);

// Customer Payments
export const getCustomerPayments = (params) => api.get('/customer-payments', { params });
export const createCustomerPayment = (data) => api.post('/customer-payments', data);
export const updateCustomerPayment = (id, data) => api.put(`/customer-payments/${id}`, data);
export const deleteCustomerPayment = (id) => api.delete(`/customer-payments/${id}`);

// FX Rates (Accounting → Currency Rates) — dual-currency branches only
export const getFxRates = () => api.get('/fx-rates');
export const getCurrentFxRate = () => api.get('/fx-rates/current');
export const createFxRate = (data) => api.post('/fx-rates', data);
export const deleteFxRate = (id) => api.delete(`/fx-rates/${id}`);
export const getLiveFxRate = () => api.get('/fx-rates/live');
export const getLiveFxRateHistory = (days = 7) => api.get('/fx-rates/live-history', { params: { days } });

// Users
export const getUsers = () => api.get('/users');
export const getUserStats = () => api.get('/users/stats');
export const createUser = (data) => api.post('/users', data);
export const updateUser = (id, data) => api.put(`/users/${id}`, data);
export const deleteUser = (id) => api.delete(`/users/${id}`);

// ZRA Smart Invoice (VSDC) — Step 2 config + initialize, Step 3 sync
export const getZraSettings   = () => api.get('/zra/settings');
export const saveZraSettings  = (data) => api.put('/zra/settings', data);
export const initializeZra    = () => api.post('/zra/initialize');
export const getZraAuditLog   = (params = {}) => api.get('/zra/audit-log', { params });
export const syncZraCodes         = (full = false) => api.post('/zra/sync/codes',        { full });
export const syncZraItemClasses   = (full = false) => api.post('/zra/sync/item-classes', { full });
export const syncZraNotices       = (full = false) => api.post('/zra/sync/notices',      { full });
export const syncZraAll           = () => api.post('/zra/sync/all');
export const getZraSyncState      = () => api.get('/zra/sync-state');
export const getZraCodes          = (cls) => api.get(cls ? `/zra/codes?cls=${encodeURIComponent(cls)}` : '/zra/codes');
export const getZraItemClasses    = ({ search, level, limit } = {}) => {
  const p = new URLSearchParams();
  if (search) p.set('search', search);
  if (level)  p.set('level', level);
  if (limit)  p.set('limit', limit);
  const qs = p.toString();
  return api.get(`/zra/item-classes${qs ? '?' + qs : ''}`);
};
export const getZraNotices        = () => api.get('/zra/notices');
// v1.13.37 — offline bulk import of ZRA's UNSPSC Excel. Bypasses the
// VSDC WAR so Kelete can populate zra_item_classes before the WAR is
// installed. Same target table as /zra/sync/item-classes.
export const importZraItemClassesXlsx = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/zra/import-item-classes', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
  });
};
// v1.13.81 — T06A VSDC-supplier purchase pull.
// pullZraPurchases({ full }) fetches new supplier invoices from
// /trnsPurchase/selectTrnsPurchaseSales and upserts into
// zra_pending_purchases. Approve fires savePurchase(regTyCd='A').
export const pullZraPurchases    = (full = false) => api.post('/zra/purchases/pull', { full });
// v1.13.94 — manual ZRA retry for a single order stuck in FAILED status.
export const retryOrderZra       = (id) => api.post(`/orders/${id}/retry-zra`);
export const getZraPurchases     = (status) => api.get(status ? `/zra/purchases?status=${encodeURIComponent(status)}` : '/zra/purchases');
export const getZraPurchase      = (id) => api.get(`/zra/purchases/${id}`);
// line_map: [{ itemCd, action: 'MAP'|'CREATE'|'IGNORE', product_sync_id? }]
// Required — the backend rejects an approve with any undecided line, so
// supplier item codes can never silently auto-create duplicate products.
export const approveZraPurchase  = (id, destination_slug, line_map) =>
  api.post(`/zra/purchases/${id}/approve`, { destination_slug, line_map });
export const rejectZraPurchase   = (id, reason) => api.post(`/zra/purchases/${id}/reject`, { reason });
// v1.13.128 — VSDC live TPIN lookup for B2B checkout. Returns
// { exists, customer: { tpin, name, address, email, phone, active } }.
export const lookupZraCustomer   = (tpin) => api.get(`/zra/customer-lookup/${encodeURIComponent(tpin)}`);
// v1.13.128 — VSDC invoice recovery lookup. Returns { exists, data }.
// Used by the ZRA settings UI to diagnose stuck invoices.
export const lookupZraInvoice    = (invcNo) => api.get(`/zra/invoices/${encodeURIComponent(invcNo)}`);
// v1.13.128 — item registry reconciliation. Returns { total_on_zra,
// matched, missing_on_zra, missing_locally, tax_mismatches, details }.
export const reconcileZraItems   = (full = false) => api.post('/zra/items/reconcile', { full });
// v1.13.128 — single-item lookup on VSDC for support/debug.
export const lookupZraItem       = (itemCd) => api.get(`/zra/items/${encodeURIComponent(itemCd)}`);
// v1.13.128 — pull manufacturer RRPs and refresh products.zra_rrp so
// MTV VAT calculation stays accurate as manufacturers change prices.
export const syncZraRrp          = (full = false) => api.post('/zra/rrp/sync', { full });
// v1.13.128 — reconcile local stock vs ZRA. Returns { drifts:[{id,name,itemCd,local,zra,delta}] }.
export const reconcileZraStock   = (opts = {}) => api.post('/zra/stock/reconcile', opts);
// Age of the oldest unfiscalised order. Matters for offline selling: a
// provisional receipt is already in the customer's hand, and ZRA rejects
// sales submitted too late (921/922).
export const getZraPendingFiscalisation = (warnHours) =>
  api.get('/zra/pending-fiscalisation', { params: warnHours ? { warn_hours: warnHours } : {} });
export const applyZraStockReconcile = (opts = {}) => api.post('/zra/stock/reconcile/apply', opts);
// v1.13.128 — pull ZRA-registered branches for this TPIN (bhfId, name, address, ...).
export const getZraBranches      = () => api.get('/zra/branches');
// T05A Import declarations queue (2026-08-26 — rebuilt to mirror the ZRA
// Purchase Queue). Pull caches declarations into zra_pending_imports;
// approve/reject BOTH transmit to ZRA via updateImportItems, unlike the
// purchase queue where reject is local-only. approve also takes an
// approved_qty (T05A step 3 — "the user updates the quantities").
export const pullZraImports      = (full = true) => api.post('/zra/imports/pull', { full });
export const getZraImports       = (status) => api.get(status ? `/zra/imports?status=${encodeURIComponent(status)}` : '/zra/imports');
export const getZraImport        = (id) => api.get(`/zra/imports/${id}`);
export const approveZraImport    = (id, destination_slug, approved_qty) =>
  api.post(`/zra/imports/${id}/approve`, { destination_slug, approved_qty });
export const rejectZraImport     = (id, reason) => api.post(`/zra/imports/${id}/reject`, { reason });
// v1.13.175 — sales that were rung before ZRA was connected. getZraPushPending
// only counts; pushZraPendingBatch actually sends, one small batch per call so
// the browser can show progress instead of hanging on one long request.
export const getZraPushPending   = () => api.get('/zra/push-pending');
export const pushZraPendingBatch = (limit = 10) => api.post('/zra/push-pending', { limit });

// v1.13.128b — System backup management. Lists nightly cron snapshots
// from /var/backups/kelete, lets an admin trigger a manual backup, and
// downloads a snapshot as a .tar.gz. Powers Ref 11 of the ZRA
// Self-Declaration ("provision for backup in case of power/system failure").
export const getSystemBackups    = () => api.get('/system/backups');
export const createSystemBackup  = () => api.post('/system/backup');
// Authenticated download — fetches the tar.gz with the JWT header (a
// plain <a href> would send no auth and get "Access denied"), then
// triggers a save-as via an object URL.
export const downloadSystemBackup = async (name) => {
  const res = await api.get(`/system/backups/${encodeURIComponent(name)}/download`, { responseType: 'blob' });
  const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/gzip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `kelete-backup-${name}.tar.gz`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
};

// Settings
// 2026-09-18 — where to reach this handset. Sent on every login, because
// Firebase reissues a token whenever it likes and a stale one delivers
// nothing. See frontend/src/utils/pushNotifications.js.
export const registerPushToken = (token, platform = 'android') =>
  api.post('/notifications/push-token', { token, platform });
export const unregisterPushToken = (token) =>
  api.delete('/notifications/push-token', { data: { token } });
// 2026-09-18 — the note written on any document, whatever the box is called
// there (notes / description / comment / reason). See backend/services/noteSources.js.
export const searchNotes = (q) => api.get('/search/notes', { params: { q } });
export const getSettings = () => api.get('/settings');
export const updateProfile = (data) => api.put('/settings/profile', data);
export const updateBusiness = (data) => api.put('/settings/business', data);
// 2026-09-18 — the code HQ's phones are asked for on first use. Never reads
// the code back, only whether one is set; '' clears it.
export const getAppPasscode = () => api.get('/settings/app-passcode');
export const updateAppPasscode = (code) => api.put('/settings/app-passcode', { code });
export const getDrawerPort = () => api.get('/settings/drawer-port');
export const updateDrawerPort = (port) => api.put('/settings/drawer-port', { port });
export const openCashDrawer = () => api.post('/settings/open-drawer');
export const printReceipt = (data) => api.post('/settings/print-receipt', data);
export const printReport = (data) => api.post('/settings/print-report', data);
export const printCountWorksheet = (data) => api.post('/settings/print-count-worksheet', data);

// Production
export const getProductions = () => api.get('/production');
export const getProductionStats = () => api.get('/production/stats');
export const getProduction = (id) => api.get(`/production/${id}`);
export const createProduction = (data) => api.post('/production', data);
export const updateProduction = (id, data) => api.put(`/production/${id}`, data);
export const deleteProduction = (id) => api.delete(`/production/${id}`);
export const getProductionRecentInputs = () => api.get('/production/recent-inputs');
export const getProductionRecentOutputs = () => api.get('/production/recent-outputs');

// Sales Returns
export const getSalesReturns = () => api.get('/sales-returns');
export const getSalesReturnStats = () => api.get('/sales-returns/stats');
export const getSalesReturnNotes = () => api.get('/sales-returns/notes');
export const getSalesReturn = (id) => api.get(`/sales-returns/${id}`);
export const createSalesReturn = (data) => api.post('/sales-returns', data);
export const updateSalesReturn = (id, data) => api.put(`/sales-returns/${id}`, data);
export const deleteSalesReturn = (id) => api.delete(`/sales-returns/${id}`);

// LAN Sync (Mother / Child architecture)
export const getLanConfig = () => api.get('/sync/lan-config');
// v1.8.42 — recovery helper. Marks every synced=0 row as synced=1 so the
// PROTECT-on-pull rule stops blocking remote overwrites. Use when local
// has drifted from VPS and you want VPS as truth.
export const clearPendingSyncFlags = () => api.post('/sync/clear-pending');
export const updateLanConfig = (data) => api.put('/sync/lan-config', data);
export const getLanStatus = () => api.get('/sync/lan-status');

export default api;
