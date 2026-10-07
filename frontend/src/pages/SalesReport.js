import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getPossibleDuplicates, dismissPossibleDuplicate, getOrders, getOrder, reverseOrder, reverseOrderItem, getSettings, getOrderProductSummary, getProductBreakdown, printReport, printReceipt, getSalesCashiers, getCategories, getMainCategories, createDebitNote, getOrderDebitNotes, retryOrderZra, markCnPrinted } from '../services/api';
import ExportButtons from '../components/ExportButtons';
import CategoryFilter from '../components/CategoryFilter';
import { FiFileText, FiDollarSign, FiShoppingCart, FiCalendar, FiEye, FiRotateCcw, FiX, FiPrinter, FiDownload, FiRefreshCw, FiAlertTriangle, FiSearch } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { formatStock, formatStockForProduct } from '../utils/unitFormat';
import { pickDisplayUnit, displayPriceInDefaultUnit, displayInDefaultUnit } from '../utils/productUnits';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import printHtml, { downloadPdf, shouldShowMobilePdfButton } from '../utils/printHtml';
import { isTerminal58, buildReceipt58 } from '../utils/receipt58';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';
import InvoiceNo from '../components/InvoiceNo';
import Portal from '../utils/Portal';
import QRCode from 'qrcode';

// 2026-08-30 â€” thousand separators on printed receipt figures. 306,000.00
// reads at a glance; 306000.00 has to be counted. Fixed en-US grouping so a
// till's locale cannot turn the decimal point into a comma on a tax invoice.
const rcptMoney = (n) =>
  (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const _d = new Date(); const today = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;

// Partial reverse (per-item void) is disabled â€” it can flip AR negative on
// part-paid sales because the line refund reduces total_amount without
// touching amount_received. For partial returns, use Sales Return / Credit
// Notes instead. The backend route still exists; flip this flag back to
// `true` to re-enable the UI without any other changes.
// v1.8.12 â€” flipped to true for Kelete. Per-line reverse now refunds cash
// proportionally across USD/FRA/K (mirroring how the customer paid), so the
// Cash Report's per-currency buckets stay in sync after a partial reverse.
const PARTIAL_REVERSE_ENABLED = true;

const SalesReport = () => {
  const { hasPermission, user: authUser } = useAuth();
  const isAdmin = authUser?.role === 'Administrator';
  const { symbol: curSym, currencyMode, isLiquorStyle, methodShown } = useCurrency();
  // v1.9.26 â€” gate the USD/FRA/K rows + columns on the branch's
  // currency_mode. Mansa/Lusaka run K-only and should see one column.
  const showUSD = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const showFRA = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const showK   = currencyMode === 'USD+FRA+K' || currencyMode === 'K';
  const { t } = useLanguage();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  // 2026-09-23 â€” two pieces of state, not one. What is TYPED and what is being
  // SEARCHED are different things now the search runs on a button: filtering on
  // every keystroke re-rendered a long table for each character, and half-typed
  // input flashed "nothing matches" before the number was finished.
  const [invoiceInput, setInvoiceInput]   = useState('');
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [userFilter, setUserFilter] = useState('all');
  const [users, setUsers] = useState([]); // [{ created_by, full_name }]
  const [viewOrder, setViewOrder] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [reversingItemId, setReversingItemId] = useState(null);
  const [reverseModal, setReverseModal] = useState(null); // { item, qtyToReverse }
  // v1.13.38 â€” Debit note modal state. { order, amount, reason_cd, notes, saving, error }
  const [debitNoteModal, setDebitNoteModal] = useState(null);
  // v1.13.136 â€” Reverse reason picker modal. Shown before the reversal fires
  // so the cashier picks 01â€“07 (per ZRA VSDC spec Â§6.15). Sent to the backend
  // as rfd_rsn_cd â€” used both in the ZRA saveSales payload (Garden) and to
  // stamp orders.zra_cn_rfd_rsn_cd for the CN reprint (Buseko). When '07 Other'
  // is picked, an extra text field appears â€” spec Â§6.15 says "Provide other
  // reason in brief" â€” persisted as orders.zra_cn_rfd_rsn_other.
  //
  // Flow: reason modal â†’ user picks â†’ Confirm â†’ we CLOSE reason modal +
  // OPEN the pendingDelete AdminPasswordPrompt (Sirak requirement â€” admin
  // password gate on every reversal). Prompt's onConfirm fires the actual
  // reverseOrder API call carrying rfd_rsn_cd + rfd_rsn_other.
  const [reverseReasonModal, setReverseReasonModal] = useState(null);
  // { order, reason_cd, reason_other, error }
  const [businessName, setBusinessName] = useState('Kelete');
  const [businessPhone, setBusinessPhone] = useState('');
  const [businessAddress, setBusinessAddress] = useState(''); // v1.10.63 â€” needed so reprints show address like the till receipt does.
  // v1.13.96 â€” extra business identity fields the reprint template needs so
  // the columnar Tax Invoice / Invoice layout renders the same as POS.js
  // fresh-print does (TPIN, Branch or Depot, Serial No.).
  const [businessTpin, setBusinessTpin] = useState('');
  const [branchDepotId, setBranchDepotId] = useState('');
  const [deviceSerialNo, setDeviceSerialNo] = useState('');
  const [activeTab, setActiveTab] = useState('transactions');
  // 2026-09-01 â€” COGS and Profit hidden on this page at the user's request.
  // Nothing is deleted: the figures are still computed, still exported, and
  // still drive the Profit summary card. Only the per-order columns and the
  // thermal report's margin lines are suppressed, because those are the two
  // surfaces a cashier or a customer can end up holding.
  //
  // Flip this to true to bring both back â€” it is the only edit needed.
  const SHOW_MARGIN_COLUMNS = false;

  // v1.13.155 â€” possible duplicate sales. Pairs whose items, quantities,
  // total and cashier all match within 60 seconds. The seconds gap rides on
  // each pair because that is what a person judges by: six seconds is a
  // duplicate, twenty-nine is two customers at opening time.
  const [dupes, setDupes] = useState([]);
  const [dupesOpen, setDupesOpen] = useState(false);
  const [dismissing, setDismissing] = useState(null);

  const [itemSummary, setItemSummary] = useState([]);
  const [itemSummaryLoading, setItemSummaryLoading] = useState(false);
  const [breakdown, setBreakdown] = useState(null); // { productName, items }
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  // Category filter (applies mainly to "By Item" tab)
  const [allCats, setAllCats] = useState([]);
  const [allMains, setAllMains] = useState([]);
  const [selMainIds, setSelMainIds] = useState(null);
  const [selCatIds, setSelCatIds] = useState(null);
  const fetchOrders = useCallback(async () => {
    try {
      const res = await getOrders();
      setOrders(res.data || []);
    } catch (err) {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Format a Date as `YYYY-MM-DD HH:MM:SS` in UTC (matches SQLite's datetime('now') format).
  // ISO format (with `T`) lexicographically compares > space-separator, so we MUST use space.
  const toSqliteUTC = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };

  const fetchItemSummary = useCallback(async () => {
    setItemSummaryLoading(true);
    try {
      // Convert the local-date filter into a SQLite-format UTC datetime range
      // (YYYY-MM-DD HH:MM:SS) so the string comparison against orders.created_at works.
      const fromUTC = dateFrom ? toSqliteUTC(new Date(`${dateFrom}T00:00:00`)) : '';
      const toUTC   = dateTo   ? toSqliteUTC(new Date(`${dateTo}T23:59:59`)) : '';
      const res = await getOrderProductSummary(fromUTC, toUTC, userFilter);
      setItemSummary(res.data || []);
    } catch (err) {
      setItemSummary([]);
    } finally {
      setItemSummaryLoading(false);
    }
  }, [dateFrom, dateTo, userFilter]);

  const handleProductBreakdown = async (productName) => {
    setBreakdownLoading(true);
    setBreakdown({ productName, items: [] });
    try {
      const fromUTC = dateFrom ? toSqliteUTC(new Date(`${dateFrom}T00:00:00`)) : '';
      const toUTC   = dateTo   ? toSqliteUTC(new Date(`${dateTo}T23:59:59`)) : '';
      const res = await getProductBreakdown(productName, fromUTC, toUTC, userFilter);
      setBreakdown({ productName, items: res.data || [] });
    } catch (err) {
      setBreakdown({ productName, items: [] });
    } finally {
      setBreakdownLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
    getSettings().then(r => {
      const biz = r.data?.business || r.data || {};
      if (biz.business_name) setBusinessName(biz.business_name);
      if (biz.business_phone) setBusinessPhone(biz.business_phone);
      if (biz.business_address) setBusinessAddress(biz.business_address);
      if (biz.zra_tpin)         setBusinessTpin(biz.zra_tpin);
      if (biz.zra_bhf_id)       setBranchDepotId(biz.zra_bhf_id);
      if (biz.zra_dvc_srl_no)   setDeviceSerialNo(biz.zra_dvc_srl_no);
    }).catch(() => {});
    getCategories().then(r => setAllCats(r.data || [])).catch(() => {});
    getMainCategories().then(r => setAllMains(r.data || [])).catch(() => {});
  }, [fetchOrders]);

  useEffect(() => {
    setUserFilter('all');
    getSalesCashiers(null, dateFrom, dateTo)
      .then(r => setUsers(r.data || []))
      .catch(() => setUsers([]));
  }, [dateFrom, dateTo]);

  // 2026-09-01 â€” was gated on activeTab === 'byItem'. Excel and CSV are now
  // by-item like the PDF, so the summary has to exist before the By Item tab
  // has ever been opened â€” otherwise exporting from Transactions silently
  // produced an empty sheet.
  useEffect(() => {
    fetchItemSummary();
  }, [activeTab, fetchItemSummary]);

  // Same date range as the report itself, so the banner always describes the
  // period on screen rather than "today" regardless of the filter.
  const fetchDupes = useCallback(async () => {
    try {
      const fromUTC = dateFrom ? toSqliteUTC(new Date(`${dateFrom}T00:00:00`)) : '';
      const toUTC   = dateTo   ? toSqliteUTC(new Date(`${dateTo}T23:59:59`)) : '';
      const { data } = await getPossibleDuplicates(fromUTC, toUTC);
      setDupes(data?.pairs || []);
    } catch (e) {
      setDupes([]);   // never let a review aid break the report
    }
  }, [dateFrom, dateTo]);

  useEffect(() => { fetchDupes(); }, [fetchDupes]);

  // Every order that is half of a suspect pair, so a row can mark itself.
  const dupeSyncIds = useMemo(() => {
    const m = new Map();
    for (const p of dupes) {
      m.set(p.a_sync_id, p);
      m.set(p.b_sync_id, p);
    }
    return m;
  }, [dupes]);

  const handleDismissDupe = async (p) => {
    if (!window.confirm(
      `Mark ${p.a_number} and ${p.b_number} as NOT duplicates?\n\n`
      + `Both sales stay exactly as they are â€” nothing is reversed, deleted or `
      + `refunded. This only stops the warning appearing again.`
    )) return;
    setDismissing(p.pair_key);
    try {
      await dismissPossibleDuplicate({
        order_a_sync_id: p.a_sync_id, order_b_sync_id: p.b_sync_id,
        order_a_number: p.a_number,   order_b_number: p.b_number,
      });
      setDupes(list => list.filter(x => x.pair_key !== p.pair_key));
    } catch (e) {
      alert(e?.response?.data?.error || 'Could not save that.');
    } finally {
      setDismissing(null);
    }
  };

  // 2026-09-23 â€” find a sale by EITHER number.
  //
  // A row carries two identities: ZRA's receipt (INV0060003843/2755) and ours
  // (INV-2026-6CF8A5-2746). A customer quotes the first, a cashier remembers
  // the second, and until now neither could be searched â€” you had to know the
  // date and scroll. Typing 2746 now matches both, as does the whole string.
  //
  // Credit and debit notes carry their own ZRA receipt, so those are matched
  // too: a reversal is exactly the thing someone rings up about.
  const invoiceHaystack = (o) => {
    const sdc   = String(o.zra_sdc_id || '').replace(/^SDC/i, '');
    const cnSdc = String(o.zra_cn_sdc_id || o.zra_sdc_id || '').replace(/^SDC/i, '');
    return [
      o.order_number,
      o.zra_rcpt_no    ? `INV${sdc}/${o.zra_rcpt_no}`      : '',
      o.zra_cn_rcpt_no ? `CRN${cnSdc}/${o.zra_cn_rcpt_no}` : '',
      o.zra_rcpt_no, o.zra_cn_rcpt_no, o.zra_cis_invc_no,
    ].filter(Boolean).join(' ').toLowerCase();
  };

  const invoiceQuery = invoiceSearch.trim().toLowerCase();

  const filtered = orders.filter(o => {
    // A search is a search: it looks across everything loaded, not just the
    // dates on screen. Someone holding a receipt from last week should not
    // have to work out which day it was before they can find it.
    if (invoiceQuery) return invoiceHaystack(o).includes(invoiceQuery);

    const od = new Date(o.created_at + 'Z');
    const orderLocalDate = `${od.getFullYear()}-${String(od.getMonth()+1).padStart(2,'0')}-${String(od.getDate()).padStart(2,'0')}`;
    if (dateFrom && orderLocalDate < dateFrom) return false;
    if (dateTo && orderLocalDate > dateTo) return false;
    if (userFilter !== 'all' && String(o.created_by) !== String(userFilter)) return false;
    return true;
  });

  const activeOrders = filtered.filter(o => o.status !== 'Reversed');
  const totalRevenue = activeOrders.reduce((sum, o) => sum + parseFloat(o.total_amount || 0), 0);
  const totalDiscount = activeOrders.reduce((sum, o) => sum + parseFloat(o.discount || 0), 0);
  const totalSubtotal = activeOrders.reduce((sum, o) => sum + parseFloat(o.subtotal || 0), 0);
  // v1.13.50 â€” COGS + Profit summary. Backend attaches per-order cogs from
  // stock_movements.cost_at_sale (frozen at the moment of each sale). Profit
  // is revenue minus cogs at the ROW level, then summed â€” no re-derivation
  // from live cost. Rows for reversed orders are already filtered above.
  const totalCogs   = activeOrders.reduce((sum, o) => sum + parseFloat(o.cogs || 0), 0);
  const totalProfit = totalRevenue - totalCogs;
  // Cash vs Credit split. Cash portion = the part of the sale paid at the till, capped at the
  // sale total â€” over-payments come back as change to the customer, so they're NOT revenue.
  // Credit portion = whatever wasn't paid at the till (becomes AR).
  const totalCashSales   = activeOrders.reduce((sum, o) => sum + Math.min(parseFloat(o.amount_received || 0), parseFloat(o.total_amount || 0)), 0);
  // v1.8.76 â€” only count actual credit sales (payment_method Credit / Partial-Credit).
  // Walk-in shortages within tolerance have total > received but are 'Cash' â€” those
  // are silent shop losses, NOT customer debt, so they shouldn't inflate Credit Sales.
  const totalCreditSales = activeOrders.reduce((sum, o) => {
    if (o.payment_method !== 'Credit' && o.payment_method !== 'Partial-Credit') return sum;
    return sum + Math.max(0, parseFloat(o.total_amount || 0) - parseFloat(o.amount_received || 0));
  }, 0);

  // v1.8.1 â€” triple-currency breakdown for Cash Sales card + By Payment tab.
  // Each in its own currency: USD net of USD change, FRA net of FRA change,
  // K net of K change. Kelete is cash-only across 3 currencies (no card / MoMo
  // / bank); these three buckets sum to the cash drawer in each currency.
  // v1.8.68 â€” switched USD subtraction from change_amount (USD-equivalent of
  // ALL change owed) to usd_change_given (physical USD returned only). Fixes
  // the phantom negative-USD when customer overpaid in FRA.
  const totalUsdReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.cash_received || 0) - parseFloat(o.usd_change_given ?? o.change_amount ?? 0), 0);
  const totalFraReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.fra_received || 0) - parseFloat(o.fra_change_given || 0), 0);
  const totalKReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.k_received || 0) - parseFloat(o.k_change_given || 0), 0);

  // v1.9.27 â€” method-axis totals for Liquor-style branches (Mansa/Lusaka).
  // v1.9.29 â€” corrected field names. POS writes the walk-in modal's per-
  // method amounts into cash_received / momo_received / bank_received
  // (not cash / momo / bank). On Kelete branches these same columns hold
  // the USD/FRA-equivalent breakdown, but isLiquorStyle gates the reads
  // so they only matter on K-only multi-method branches.
  // v1.10.101 â€” subtract change_amount from Cash total on Liquor so the
  // per-method Cash card matches the â‰ˆ total footer (both settle to the
  // capped-at-total_amount value). Change on Liquor always comes out of
  // Cash drawer, never from MoMo/Bank. These variables are only rendered
  // on isLiquorStyle branches (line 878), so Kassumbalesa is untouched.
  const totalCashReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.cash_received || 0) - parseFloat(o.change_amount || 0), 0);
  const totalMomoReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.momo_received || 0), 0);
  const totalBankReceived = activeOrders.reduce((s, o) =>
    s + parseFloat(o.bank_received || 0), 0);
  const totalCreditByMethod = activeOrders.reduce((s, o) =>
    s + Math.max(0, parseFloat(o.total_amount || 0) - parseFloat(o.amount_received || 0)), 0);

  // v1.8.68 â€” over-collections kept by cashier, summed per source currency.
  const totalOverpaidUSD = activeOrders.reduce((s, o) =>
    s + (o.overpaid_kept_ccy === 'USD' ? parseFloat(o.overpaid_kept_amt || 0) : 0), 0);
  const totalOverpaidFRA = activeOrders.reduce((s, o) =>
    s + (o.overpaid_kept_ccy === 'FRA' ? parseFloat(o.overpaid_kept_amt || 0) : 0), 0);
  const totalOverpaidK = activeOrders.reduce((s, o) =>
    s + (o.overpaid_kept_ccy === 'K' ? parseFloat(o.overpaid_kept_amt || 0) : 0), 0);
  const totalOverpaidAsUSD = activeOrders.reduce((s, o) => {
    const amt = parseFloat(o.overpaid_kept_amt || 0);
    if (amt <= 0) return s;
    if (o.overpaid_kept_ccy === 'USD') return s + amt;
    if (o.overpaid_kept_ccy === 'FRA' && parseFloat(o.selling_rate_used   || 0) > 0) return s + amt / parseFloat(o.selling_rate_used);
    if (o.overpaid_kept_ccy === 'K'   && parseFloat(o.selling_rate_k_used || 0) > 0) return s + amt / parseFloat(o.selling_rate_k_used);
    return s;
  }, 0);

  // v1.13.152 â€” When true, the current View modal was opened from a
  // Credit Note row (Sales Report flatMap emits both sale + CN rows for
  // reversed/partial orders). The modal footer hides Print Receipt +
  // Reverse Order in this case â€” the CN view should only offer Close
  // and Print Credit Note, matching what the cashier expects when
  // clicking a CN's own row.
  const [viewedAsCn, setViewedAsCn] = useState(false);
  const handleView = async (orderId, { asCn = false } = {}) => {
    setViewLoading(true);
    setViewedAsCn(!!asCn);
    try {
      const res = await getOrder(orderId);
      // v1.13.100 â€” hydrate any DNs so the Print Debit Note button in
      // the modal footer shows a badge count and lets the user reprint.
      let dns = [];
      try {
        const dnRes = await getOrderDebitNotes(orderId);
        dns = Array.isArray(dnRes.data) ? dnRes.data : [];
      } catch (_) { /* non-fatal */ }
      setViewOrder({ ...res.data, __debitNotes: dns });
    } catch (err) {
      alert('Failed to load order details.');
    } finally {
      setViewLoading(false);
    }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  // v1.13.136 â€” Reverse flow now opens a reason picker (ZRA UAT Â§3.8(b)
  // requires the CN carry a reason). Default to '01 Wrong product' â€” first
  // code in the ZRA VSDC spec Â§6.15 list. Cashier can change before
  // confirming. The chosen code flows into both the ZRA CN payload (Garden)
  // and the local reprint (Buseko, where ZRA is off).
  const handleReverse = (order) => {
    if (order.status === 'Reversed') return;
    setReverseReasonModal({ order, reason_cd: '01', reason_other: '', error: null });
  };
  // Reason picker â†’ Confirm â†’ validate â†’ close reason modal â†’ open
  // AdminPasswordPrompt (pendingDelete). Actual reverseOrder call fires
  // from AdminPasswordPrompt's onConfirm handler (confirmDelete â†’ perform).
  const proceedToAdminPasswordAfterReason = () => {
    if (!reverseReasonModal) return;
    const { order, reason_cd, reason_other } = reverseReasonModal;
    if (reason_cd === '07' && !String(reason_other || '').trim()) {
      setReverseReasonModal(m => ({ ...m, error: 'Please briefly describe the reason.' }));
      return;
    }
    const otherText = reason_cd === '07' ? String(reason_other).trim() : null;
    setReverseReasonModal(null);
    setPendingDelete({
      subject: `Reverse order ${fmtInvoiceNo(order.order_number)} â€” voids sale, restores stock, issues Credit Note (${reason_cd}${otherText ? ' â€” ' + otherText : ''})`,
      actionLabel: 'Confirm Reverse',
      perform: async () => {
        try {
          await reverseOrder(order.id, { rfd_rsn_cd: reason_cd, rfd_rsn_other: otherText });
          await fetchOrders();
          alert(`Order ${fmtInvoiceNo(order.order_number)} has been reversed successfully.`);
        } catch (err) {
          alert(err.response?.data?.error || 'Failed to reverse order.');
        }
      },
    });
  };

  // Open the partial-reverse modal (lets user pick how much to reverse and in what unit)
  const handleReverseItem = (item) => {
    if (item.reversed) return;
    const alreadyReversed = parseFloat(item.reversed_quantity || 0);
    const remaining = parseFloat(item.quantity) - alreadyReversed;
    if (!(remaining > 0)) {
      alert('Nothing left to reverse on this line.');
      return;
    }
    // Default the reverse unit to whatever was sold (item.unit)
    setReverseModal({ item, qtyToReverse: String(remaining), unit: item.unit || item.product_base_unit || '', reason_cd: '01', reason_other: '', error: null });
  };

  const confirmReverseItem = async () => {
    if (!reverseModal) return;
    const { item, qtyToReverse, unit, reason_cd, reason_other } = reverseModal;
    const qty = parseFloat(qtyToReverse);
    if (!(qty > 0)) { alert('Enter a quantity greater than 0.'); return; }
    if (reason_cd === '07' && !String(reason_other || '').trim()) {
      setReverseModal(m => ({ ...m, error: 'Please briefly describe the reason.' }));
      return;
    }

    // Compute remaining in the chosen unit so we can validate client-side too
    const conv = parseFloat(item.conversion_factor || 1);
    const isLineAlt = !!(item.alt_unit && item.unit === item.alt_unit);
    const isReverseAlt = !!(item.alt_unit && unit === item.alt_unit);
    const alreadyReversed = parseFloat(item.reversed_quantity || 0);
    const remainingInLineUnit = parseFloat(item.quantity) - alreadyReversed;
    const remainingBase = isLineAlt ? remainingInLineUnit * conv : remainingInLineUnit;
    const remainingInReverseUnit = isReverseAlt ? remainingBase / conv : remainingBase;
    if (qty > remainingInReverseUnit + 0.0001) {
      alert(`Cannot reverse more than ${(parseFloat(remainingInReverseUnit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} ${unit}.`);
      return;
    }

    setReversingItemId(item.id);
    try {
      const otherText = reason_cd === '07' ? String(reason_other).trim() : null;
      await reverseOrderItem(viewOrder.id, item.id, qty, unit, { rfd_rsn_cd: reason_cd, rfd_rsn_other: otherText });
      // v1.13.147 â€” the partial-reverse endpoint returns only the base
      // order shape (no items[] array), which was overwriting
      // viewOrder and blanking the modal until the cashier closed +
      // reopened it. Re-fetch the full order + DN list so the modal
      // rerenders with the updated line + PARTIAL REFUNDS section on
      // the first paint.
      const fresh = await getOrder(viewOrder.id);
      let dns = [];
      try {
        const dnRes = await getOrderDebitNotes(viewOrder.id);
        dns = Array.isArray(dnRes.data) ? dnRes.data : [];
      } catch (_) { /* non-fatal */ }
      setViewOrder({ ...fresh.data, __debitNotes: dns });
      setReverseModal(null);
      await fetchOrders();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to reverse item.');
    } finally {
      setReversingItemId(null);
    }
  };

  const formatDate = (d) => new Date(d + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const printDirect = (html) => printHtml(html);

  // 2026-09-01 â€” Sales report on the 80mm thermal roll. Export PDF and Print
  // Report both produce an A4 sheet; a depot wanting the day's figures at the
  // counter had to find a normal printer. Same by-item figures, same sort, cut
  // to 72mm â€” the printable width of an 80mm roll, matching every receipt in
  // this file.
  //
  // Arial at normal weight for the same reason the receipts changed: bold
  // Courier at 9px merges dots on a 203dpi head.
  const handleThermalReport = async () => {
    const fmtT = (v) => parseFloat(v || 0).toLocaleString(undefined,
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const esc = (v) => String(v == null ? '' : v).replace(/</g, '&lt;');

    // Fetch on demand so the button works from any tab, exactly as the PDF
    // does, and fall back to whatever is already on screen if the call fails.
    let items = [];
    try {
      const fromUTC = dateFrom ? toSqliteUTC(new Date(`${dateFrom}T00:00:00`)) : '';
      const toUTC   = dateTo   ? toSqliteUTC(new Date(`${dateTo}T23:59:59`)) : '';
      const res = await getOrderProductSummary(fromUTC, toUTC, userFilter);
      items = res.data || [];
    } catch (e) {
      items = itemSummary || [];
    }
    items = items.slice().sort((a, b) =>
      parseFloat(b.total_revenue || 0) - parseFloat(a.total_revenue || 0));

    const rows = items.map((it) => {
      const q = displayInDefaultUnit(it.total_qty, it);
      const u = displayPriceInDefaultUnit(it.avg_price, it);
      return `<tr>
        <td>${esc(it.product_name || '-')}</td>
        <td class="n">${Number(q.qty || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
        <td class="n">${fmtT(it.total_revenue)}</td>
      </tr>
      <tr><td class="sub" colspan="3">${esc(u.unit || it.unit || '')} @ ${curSym}${fmtT(u.price || it.avg_price)}</td></tr>`;
    }).join('');

    const grand = items.reduce((s2, it) => s2 + parseFloat(it.total_revenue || 0), 0);
    const range = dateFrom === dateTo ? dateFrom : `${dateFrom} to ${dateTo}`;
    const printedBy = [authUser?.firstName, authUser?.lastName].filter(Boolean).join(' ') || '-';
    const eq = '='.repeat(42);
    const da = '-'.repeat(42);

    printDirect(`<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Sales Report</title>
<style>
  @page { size: 72mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; overflow-x: hidden; }
  /* 2026-09-01 â€” was padding: 2mm all round. The left edge printed off
     the paper: RED SEA came out as ED SEA, Cashier as ashier. The page
     is exactly 72mm (box-sizing is border-box above), so nothing is
     overflowing â€” the print head simply starts a couple of millimetres
     right of where the browser puts x=0. Moving the padding from the
     right side to the left shifts the content across without making
     the content area any narrower: 4 + 0 is the same 4mm as 2 + 2.
     If the left is STILL clipped, raise the 4mm. If the right now
     clips instead, lower it. */
  body { width: 72mm; max-width: 72mm; padding: 2mm 0 2mm 4mm;
         font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
         font-size: 11px; color: #000; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  td { padding: 1px 0; vertical-align: top; font-variant-numeric: tabular-nums; }
  .c { text-align: center; }
  .n { text-align: right; white-space: nowrap; padding-left: 4px; }
  .divider { text-align: center; font-size: 10px; overflow: hidden;
             white-space: nowrap; margin: 3px 0; }
  .items td { font-size: 10px; }
  .items .sub { font-size: 9px; color: #444; padding: 0 0 3px 6px; }
  .head td { font-weight: 700; border-bottom: 1px solid #000; font-size: 9px; }
  .big { font-weight: 700; font-size: 12px; }
</style></head><body>
  <div class="c" style="font-size:13px;font-weight:700;">${esc(businessName || 'RED SEA')}</div>
  <div class="divider">${eq}</div>
  <div class="c" style="font-weight:700;letter-spacing:1px;">SALES BY ITEM</div>
  <div class="divider">${eq}</div>
  <table>
    <tr><td>Period:</td><td class="n">${esc(range)}</td></tr>
    <tr><td>Printed:</td><td class="n">${new Date().toLocaleString('en-GB')}</td></tr>
    <tr><td>By:</td><td class="n">${esc(printedBy)}</td></tr>
  </table>
  <div class="divider">${eq}</div>
  <table class="items">
    <tr class="head"><td>Item</td><td class="n">Qty</td><td class="n">Revenue</td></tr>
    ${rows || '<tr><td colspan="3" class="c">No sales in this period.</td></tr>'}
  </table>
  <div class="divider">${da}</div>
  <table>
    <tr class="big"><td>TOTAL</td><td class="n">${curSym}${fmtT(grand)}</td></tr>
    <tr><td>Products</td><td class="n">${items.length}</td></tr>
  </table>
  <div class="divider">${eq}</div>
  <table>
    <tr><td>Revenue</td><td class="n">${curSym}${fmtT(totalRevenue)}</td></tr>
    <tr><td>Cash</td><td class="n">${curSym}${fmtT(totalCashSales)}</td></tr>
    <tr><td>Credit</td><td class="n">${curSym}${fmtT(totalCreditSales)}</td></tr>
    <tr><td>Discount</td><td class="n">${curSym}${fmtT(totalDiscount)}</td></tr>
    ${SHOW_MARGIN_COLUMNS ? `
    <tr><td>COGS</td><td class="n">${curSym}${fmtT(totalCogs)}</td></tr>
    <tr class="big"><td>PROFIT</td><td class="n">${curSym}${fmtT(totalProfit)}</td></tr>` : ''}
    <tr><td>Orders</td><td class="n">${activeOrders.length}</td></tr>
  </table>
  <div class="divider">${eq}</div>
  <div class="c" style="font-size:10px;">Internal report - not a tax invoice.</div>
</body></html>`);
  };

  // v1.13.38 â€” Debit Note modal handlers.
  const openDebitNoteModal = (order) => setDebitNoteModal({
    order,
    amount: '',
    reason_cd: '07',
    notes: '',
    saving: false,
    error: null,
    success: null,
  });
  const submitDebitNote = async () => {
    if (!debitNoteModal) return;
    const amt = parseFloat(debitNoteModal.amount);
    if (!(amt > 0)) {
      setDebitNoteModal(m => ({ ...m, error: 'Amount must be greater than zero.' }));
      return;
    }
    setDebitNoteModal(m => ({ ...m, saving: true, error: null }));
    try {
      const { data } = await createDebitNote(debitNoteModal.order.id, {
        amount: amt,
        reason_cd: debitNoteModal.reason_cd,
        notes: debitNoteModal.notes || null,
      });
      const zraNote = data?.zra?.skipped
        ? ' (ZRA skipped â€” original not fiscal)'
        : data?.zra?.ok
          ? ` (ZRA rcpt ${data?.zra?.rcptNo})`
          : data?.zra
            ? ` (ZRA failed â€” will retry: ${data?.zra?.error || ''})`
            : '';
      setDebitNoteModal(m => ({ ...m, saving: false, success: `Debit note ${data.dn_number} created${zraNote}.`, createdDn: data }));
    } catch (e) {
      setDebitNoteModal(m => ({ ...m, saving: false, error: e?.response?.data?.error || e.message }));
    }
  };

  const handlePrintReceipt = async (order) => {
    // v1.13.96 â€” SalesReport reprint now uses the same columnar Access-
    // style layout as fresh POS.js prints (v1.13.95). SIGNED orders get
    // the full Tax Invoice with QR + fiscal footer; everything else
    // gets the plain "Invoice" variant. Always adds the "*** COPY /
    // DUPLICATE ***" band on top (ZRA UAT #24) so no one mistakes a
    // reprint for the original. ESC/POS backend path deleted â€” the
    // legacy Kelete/Liquor slip no longer prints from Sales Report.
    // v1.13.136 â€” "Print Receipt" now ALWAYS prints the original invoice
    // (as a COPY/DUPLICATE reprint), never the CN â€” even for reversed
    // orders. This restores ZRA UAT Â§3.8 audit-trail requirement: the
    // original tax invoice must remain reprintable in its original form
    // so ZRA can see what was actually sold. Prior behavior (v1.13.122)
    // auto-swapped to CN mode on reversed orders, which meant the
    // original invoice paper trail was inaccessible from the UI.
    // Reprinting the CN itself is now done via the dedicated "Print CN"
    // button (handlePrintCreditNote) â€” see line ~1625 for the button.
    try {
      const html = await buildColumnarReprintHtml(order);
      printDirect(html);
    } catch (err) {
      // Ultimate fallback to the legacy layout so a broken template
      // never blocks a cashier who needs a copy of the receipt.
      console.error('[SalesReport] columnar reprint failed:', err);
      printDirect(buildReceiptHtml(order, { isReprint: true }));
    }
  };

  // 2026-09-10 â€” on a POS small terminal, a sale's receipt prints straight
  // from its row: load the sale, print it, no window in between. The View
  // window is taller than a handheld's screen and its Print button sits out
  // of reach. View itself is unchanged and still opens the details.
  const handleQuickPrint = async (orderId) => {
    let order;
    try {
      order = (await getOrder(orderId)).data;
    } catch (_) {
      alert('Could not load this sale to print it.');
      return;
    }
    await handlePrintReceipt(order);
  };

  // v1.13.100 â€” Print Tax Credit Note (T08A #13). Only meaningful on
  // orders that were reversed AND had ZRA CN fiscal data returned. The
  // template branch inside buildColumnarReprintHtml swaps INVâ†’CRN,
  // switches the fiscal footer to zra_cn_*, and adds the cross-reference
  // to the original invoice + refund reason.
  // v1.13.136 â€” Print CN is available on ANY reversed order â€” Garden
  // (ZRA-signed CN via zra_cn_rcpt_no) or Buseko (local CN number stamped
  // by the backend's non-fiscal reversal path). Both flows read the same
  // template branch; the template chooses which CN identifier to render
  // based on which fields are populated (zra_cn_signed_at gates the block;
  // rcptRef falls back to local_cn_number when zra_cn_rcpt_no is null).
  //
  // v1.13.136 â€” Also owns the CN cn_first_printed_at tracking (moved out
  // of the default Print Receipt handler when reversed-order Print Receipt
  // switched to reprint the ORIGINAL invoice instead of auto-printing CN).
  // First CN print stays clean; 2nd+ prints stamp *** COPY / DUPLICATE ***
  // via opts.isCnDuplicate â†’ the title block header renders the extra band.
  const handlePrintCreditNote = async (order) => {
    const hasFiscalCn = !!(order?.zra_cn_signed_at && order?.zra_cn_rcpt_no);
    const hasLocalCn  = !!(order?.zra_cn_signed_at && order?.local_cn_number);
    if (!hasFiscalCn && !hasLocalCn) {
      alert('This order has no Credit Note yet. Reverse the order first.');
      return;
    }
    try {
      const isCnFirstPrint = !order?.cn_first_printed_at;
      const html = await buildColumnarReprintHtml(order, {
        mode: 'credit-note',
        isCnDuplicate: !isCnFirstPrint,
      });
      printDirect(html);
      if (isCnFirstPrint) {
        const nowIso = new Date().toISOString();
        order.cn_first_printed_at = nowIso;
        setViewOrder((prev) => (prev && prev.id === order.id
          ? { ...prev, cn_first_printed_at: nowIso }
          : prev));
        markCnPrinted(order.id).catch((e) => console.warn('markCnPrinted failed:', e?.message));
      }
    } catch (err) {
      console.error('[SalesReport] credit-note print failed:', err);
      alert('Failed to render the Credit Note.');
    }
  };

  // v1.13.96 â€” Access-style reprint. Mirrors POS.js printThermalReceiptFallback
  // structure so provisional and fiscal copies stay visually consistent
  // across fresh sale and reprint code paths.
  //
  // v1.13.100 â€” added mode='credit-note' branch (T08A #13). When set, the
  // template renders as a Tax Credit Note: CRN prefix, own QR/sig/sdcId
  // from zra_cn_* fields, cross-reference to the original invoice, and a
  // reason-code line. mode='invoice' (default) is the ordinary reprint.
  const CN_REASON_LABEL = {
    '01': 'Wrong product',
    '02': 'Wrong price',
    '03': 'Damaged',
    '04': 'Wrong customer',
    '05': 'Duplicate',
    '06': 'Excess',
    '07': 'Other',
  };
  const buildColumnarReprintHtml = async (order, opts = {}) => {
    const mode = opts.mode || 'invoice';
    const isCreditNote = mode === 'credit-note';
    // For CN mode we require the CN's own fiscal signature. Fall back to
    // ordinary reprint if the CN hasn't been signed yet.
    // v1.13.136 â€” CN mode is "signed" if EITHER (a) ZRA returned a fiscal
    // signature (Garden) OR (b) the backend stamped a local CN number for
    // a non-fiscal reversal (Buseko). Both paths get the CN block rendered.
    // Only difference is which identifier fills the Credit Note No. line
    // (see rcptRef computation below) and whether the fiscal signature
    // block appears (QR, sdcId, security data â€” only for fiscal).
    const cnSigned = isCreditNote && !!order.zra_cn_signed_at
      && (!!order.zra_cn_rcpt_no || !!order.local_cn_number);
    const cnIsFiscal = isCreditNote && !!order.zra_cn_rcpt_no && !!order.zra_cn_sdc_id;
    const isSigned = isCreditNote ? cnSigned : (order.zra_status === 'SIGNED');
    // 2026-09-01 â€” EMPTIES block on a reprint. The voucher comes from
    // GET /orders/:id as empty_voucher, added the same day: the claim lives
    // in empty_voucher_claims and no endpoint had ever returned it, so a
    // duplicate used to say LESS than the original. Dispatch reads this
    // block to decide whether to release goods, so the copy has to carry it.
    // Prints nothing when the sale drew on no voucher.
    const emptiesBlock = (d, dashRule) => {
      const v = d && d.empty_voucher;
      const qty = v ? (parseInt(v.qty_claimed, 10) || 0) : 0;
      if (!v || !v.voucher_number || qty <= 0) return '';
      return `
      <div class="divider">${dashRule}</div>
      <table>
        <tr><td colspan="2" style="font-weight:700;">EMPTIES</td></tr>
        <tr><td style="padding-left:6px;">Voucher</td>
            <td style="text-align:right;">${String(v.voucher_number).replace(/</g, '&lt;')}</td></tr>
        <tr><td style="padding-left:6px;">Returned</td>
            <td style="text-align:right;font-weight:700;">${qty}</td></tr>
      </table>`;
    };
    const div42eq = '='.repeat(42);
    const div42da = '-'.repeat(42);
    const fmtCode = (s) => (s ? String(s) : 'â€”');
    const buyerTpin = order.customer_tpin || '1000000000';
    const bName = businessName;
    const bAddress = businessAddress;
    const bPhone = businessPhone;
    const cashierName = order.served_by || order.cashier_name || order.created_by_name || 'Staff';

    // MTV boost math identical to POS.js so provisional + fiscal
    // reprints show the same VAT.
    let totalVat = 0;
    let totalNet = 0;   // v1.13.112 â€” Ref 4(ix) total exclusive of tax
    // v1.13.137 â€” same MTV uplift accumulation as POS.js so reprints
    // render the "MTV Uplift (Absorbed)" footer line consistently.
    let totalMtvUplift = 0;
    // v1.13.126 â€” CN mode: only render items that were actually refunded
    // (fully-reversed or partial-reversed), and show REFUND qty (not
    // remaining qty). Non-CN mode keeps original behavior.
    const sourceItems = isCreditNote
      ? (order.items || []).filter(it => it.reversed || parseFloat(it.reversed_quantity || 0) > 0)
      : (order.items || []);
    const lines58 = [];   // the same per-line figures, for the 58mm layout
    const itemRows = sourceItems.map(item => {
      const origQty  = parseFloat(item.quantity || 0);
      const rq       = parseFloat(item.reversed_quantity || 0);
      const partial  = !item.reversed && rq > 0;
      // v1.13.136 â€” Invoice mode now ALWAYS shows origQty for reversed lines
      // too. The "original tax invoice" reprint must show the invoice as it
      // was issued at sale time (COPY/DUPLICATE), not as-currently-adjusted.
      // Prior behavior (qty=0 with [VOID] strikethrough) contradicted the
      // frozen snapshot in the footer (zra_vat_taxbl_amt/zra_vat_amt still
      // reflected the original sale) and produced receipts with Total=0
      // per line but non-zero VAT/Net at the bottom. The reversal state
      // is now shown via the "*** REVERSED ***" banner in the header only.
      // In CN mode qty = refunded qty (positive). Partial reversals still
      // show remaining qty on invoice reprint (matches receipt reality).
      const qty      = isCreditNote
        ? (item.reversed ? origQty : rq)
        : (item.reversed ? origQty : (partial ? Math.max(0, origQty - rq) : origQty));
      const prc      = parseFloat(item.unit_price || 0);
      const dcU      = parseFloat(item.discount || 0);
      const netInc   = qty * (prc - dcU);
      // v1.13.128j â€” Prefer frozen fiscal snapshot on order_items.
      // Reprints must show the invoice as issued, not today's math.
      const cat      = (item.zra_vat_cat_snap || item.zra_vat_cat_cd || 'A').toUpperCase();
      const rrpU     = parseFloat(item.zra_rrp_snap != null ? item.zra_rrp_snap : item.zra_rrp || 0);
      const zeroRated = ['D', 'C1', 'C2', 'C3', 'E'].includes(cat);
      const rate     = item.zra_vat_rate != null ? Number(item.zra_vat_rate) : (zeroRated ? 0 : 16);
      const boost    = cat === 'B' && rrpU > 0 ? Math.max(netInc, rrpU * qty) : netInc;
      if (boost > netInc + 0.001) totalMtvUplift += (boost - netInc);
      const vat      = item.zra_vat_amt != null
        ? (Number(item.zra_vat_amt) || 0)
        : (rate > 0 ? (boost - boost / 1.16) : 0);
      totalVat += vat;
      // v1.13.140 â€” per ZRA meeting 2026-08-21: display convention is
      // uniform â€” VAT Excl on the receipt is ALWAYS derived from actual
      // sale price (netInc âˆ’ vat), regardless of whether VAT itself was
      // computed on RRP for Cat B undersells. This keeps per-line
      // arithmetic reconciling (Excl + VAT = Line Total = Amount Due
      // summed). Frozen zra_vat_taxbl_amt snapshot is no longer read
      // for display; ZRA saveSales still ships the RRP-based taxblAmt.
      const netExcl  = netInc - vat;
      totalNet += netExcl;
      lines58.push({ cat, name: item.product_name, qty, price: prc - dcU, rate, netExcl, vat, total: netInc });
      const qtyStr   = qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2);
      // v1.13.136 â€” Never strikethrough / [VOID] individual lines on the
      // reprint. The "*** REVERSED ***" banner in the header signals the
      // reversal at the invoice level; adding VOID marks to each line
      // implied a partial-void reading of the receipt that didn't match
      // the totals. Kept for CN mode too â€” CN already isn't about voiding.
      const showStrike = false;
      const nameLabel = String(item.product_name || '').replace(/</g, '&lt;');
      // v1.13.140 â€” column set per ZRA meeting 2026-08-21:
      //   Descr | Cat | Qt | VAT Excl | Rate | VAT | Total
      //   Price column dropped (redundant with per-line Total).
      return `<tr${showStrike ? ' style="text-decoration:line-through;color:#666;"' : ''}>
          <td>${nameLabel}</td>
          <td style="text-align:center;">${cat}</td>
          <td class="n">${qtyStr}</td>
          <td class="n">${rcptMoney(netExcl)}</td>
          <td class="n">${rate}%</td>
          <td class="n">${rcptMoney(vat)}</td>
          <td class="n">${rcptMoney(netInc)}</td>
        </tr>`;
    }).join('');

    const dt = new Date(order.created_at + 'Z');
    // v1.13.137 â€” add time (Anthony item #4).
    const dateStr = dt.toLocaleString('en-GB', { hour12: false });
    const cashPaid = parseFloat(order.cash_received || 0) + parseFloat(order.fra_received || 0) + parseFloat(order.k_received || 0);
    const tendered = cashPaid > 0 ? cashPaid : parseFloat(order.amount_received || 0);
    const change   = parseFloat(order.change_amount || 0);

    // SIGNED-only fiscal footer prep: fabricate the Access-style receipt
    // ref + resolve QR data URL. CN mode uses zra_cn_* fields and a CRN
    // prefix per T08A #13.
    const sdcIdActive   = isCreditNote ? order.zra_cn_sdc_id            : order.zra_sdc_id;
    const rcptNoActive  = isCreditNote ? order.zra_cn_rcpt_no           : order.zra_rcpt_no;
    const cisInvcActive = isCreditNote ? order.zra_cn_cis_invc_no       : order.zra_cis_invc_no;
    const intrlActive   = isCreditNote ? order.zra_cn_intrl_data        : order.zra_intrl_data;
    const signActive    = isCreditNote ? order.zra_cn_rcpt_sign         : order.zra_rcpt_sign;
    const pbctActive    = isCreditNote ? order.zra_cn_vsdc_rcpt_pbct_date : order.zra_vsdc_rcpt_pbct_date;
    const qrActive      = isCreditNote ? order.zra_cn_qr_code_url       : order.zra_qr_code_url;
    const prefix        = isCreditNote ? 'CRN' : 'INV';
    const sdcSuffix     = String(sdcIdActive || '').replace(/^SDC/i, '');
    // v1.13.101 â€” ZRA spec format is `INVSDCNUMBER/INVOICE NUMBER`
    // (and `CRNSDCNUMBER/CREDITNOTE NUMBER` for CN). Dropped the
    // trailing `-00A` legacy suffix inherited from mimicking Access.
    // v1.13.128c â€” Anthony fix #4: fallback rewrites the internal order
    // prefix from ORD- to INV- so pre-VSDC reprints show INV, not ORD.
    const fallbackNum   = String(fmtCode(order.order_number)).replace(/^ORD-/, 'INV-');
    // v1.13.136 â€” In CN mode, prefer the fiscal CRN identifier when ZRA is
    // on. When ZRA is off (Garden vs Buseko), fall back to the local CN
    // number stamped by the backend on reversal â€” e.g. "CN-2026-A5C013-0197".
    // This is what ZRA UAT Â§3.8(c) wants: the CN must display a distinct
    // number that is NOT the original invoice number.
    // v1.13.148 â€” Show ZRA's rcptNo, NOT Kelete's cisInvcNo, in the
    // composite receipt number. Sirak: "if the number after the slash
    // is in the INV0060001067/â€¦ format, it MUST match what ZRA's portal
    // shows for the same transaction â€” otherwise the receipt is lying".
    // cisInvcNo (Kelete's counter) drifts ahead of rcptNo (ZRA's
    // counter) whenever a saveSales attempt fails/times-out (see Â§5.1
    // offline-mode gap). Printing cisInvcNo in an INV0060001067/â€¦
    // format that LOOKS like a ZRA-official receipt number is
    // misleading. If ZRA has signed the sale, use rcptNo (guaranteed
    // to match the portal). If not signed yet (offline queue), fall
    // back to Kelete's internal INV-2026-â€¦ order number instead of
    // fabricating a ZRA-style composite.
    const rcptRef       = isCreditNote
      ? (cnIsFiscal
          ? `${prefix}${sdcSuffix}/${rcptNoActive}`
          : (order.local_cn_number || fallbackNum))
      : (isSigned && rcptNoActive
          ? `${prefix}${sdcSuffix}/${rcptNoActive}`
          : fallbackNum);
    // Cross-reference to the original invoice (T08A #13 requires the CN
    // point back at the sale it reverses). Same rcptNo-first rule.
    const origSdcSuffix = String(order.zra_sdc_id || '').replace(/^SDC/i, '');
    const origRcptRef   = order.zra_rcpt_no
      ? `INV${origSdcSuffix}/${order.zra_rcpt_no}`
      : fallbackNum;
    const cnReasonCd    = order.zra_cn_rfd_rsn_cd || '07';
    const cnReasonLbl   = CN_REASON_LABEL[cnReasonCd] || 'Other';
    let qrDataUrl = '';
    if (isSigned && qrActive) {
      try {
        qrDataUrl = await QRCode.toDataURL(qrActive, { width: 180, margin: 1, errorCorrectionLevel: 'M' });
      } catch (_) { /* signature block still prints */ }
    }

    // v1.13.128g â€” Reprint flags. Consumed by the title block JSX below,
    // which builds the header sequence directly from these booleans:
    //   *** TAX INVOICE ***  â†’  *** COPY / DUPLICATE ***  â†’  subtitle.
    const isCnReprint  = isCreditNote && !!opts.isCnDuplicate;
    // v1.13.136 â€” Was `!isCreditNote && order.status !== 'Reversed'`. The
    // "!Reversed" clause dated from when reversed orders auto-printed as
    // CN â€” invoice reprint of a reversed order was never reachable. That
    // path now exists (Print Receipt on a reversed row reprints the
    // ORIGINAL invoice), so the reprint MUST carry the COPY / DUPLICATE
    // band. ZRA UAT Part B #7 requires it on every reprint of an original
    // invoice, regardless of the order's current status. The "*** REVERSED
    // ***" banner below stays as a separate line so ZRA can see both facts.
    const isInvReprint = !isCreditNote;

    // v1.13.136 â€” Two footer variants:
    //   (a) Full fiscal â€” ZRA-signed. Includes QR + security data + sdcId.
    //   (b) Non-fiscal CN â€” ZRA off. Skips QR/security block but still shows
    //       Credit Note No., Original Invoice ref, and Reason so ZRA UAT
    //       Â§3.8(a)+(b)+(c) requirements are visible on paper.
    const isCnNonFiscal = isCreditNote && isSigned && !cnIsFiscal;
    const fiscalFooter = isSigned && !isCnNonFiscal ? `
  <div class="divider">${div42eq}</div>
  ${qrDataUrl ? `<div class="c" style="margin:4px 0;"><img src="${qrDataUrl}" style="width:38mm;height:38mm;" alt="QR" /></div>` : ''}
  <div class="divider">${div42eq}</div>
  <table class="fisc">
    <tr><td>Receipt Number:</td><td style="text-align:right;">${rcptRef}</td></tr>
    <tr><td colspan="2">Security Data:</td></tr>
    <tr><td colspan="2">${fmtCode(intrlActive)}</td></tr>
    <tr><td>VSDC Time:</td><td style="text-align:right;">${fmtCode(pbctActive)}</td></tr>
    <tr><td>Signature:</td><td style="text-align:right;">${fmtCode(signActive)}</td></tr>
    <tr><td>Serial No.</td><td style="text-align:right;">${fmtCode(deviceSerialNo)}</td></tr>
    <tr><td colspan="2">sdcId ${fmtCode(sdcIdActive)}</td></tr>
    ${isCreditNote ? `
    <tr><td colspan="2" style="padding-top:3px;">Original Invoice:</td></tr>
    <tr><td colspan="2">${origRcptRef}</td></tr>
    <tr><td>Reason:</td><td style="text-align:right;">${cnReasonCd} â€” ${cnReasonLbl}</td></tr>` : ''}
    <tr><td colspan="2" style="padding-top:3px;">Cash Sales</td></tr>
    <tr><td colspan="2">CUSTOMER TPIN ${buyerTpin}</td></tr>
  </table>` : `<div class="divider">${div42eq}</div>`;

    // v1.13.136 â€” Non-fiscal CN footer (Buseko: ZRA off). Renders the three
    // mandatory CN identifiers per ZRA UAT Â§3.8:
    //   (a) Original Invoice reference â€” clearly labeled cross-reference
    //   (b) Reason for reversal â€” one of 01â€“07 from spec Â§6.15
    //   (c) Credit Note number â€” distinct from the original invoice number
    // Skips the fiscal signature / QR block since ZRA never signed this CN.
    // v1.13.136 â€” Non-fiscal CN footer stripped per Sirak: Credit Note No.,
    // Original Invoice, and Reason all appear in the top header block
    // already (see line ~726). Cash Sales + CUSTOMER TPIN removed â€” buyer
    // TPIN is on the top block as "Buyer TPIN:" (ZRA UAT Â§3.8(vii)) and
    // "Cash Sales" isn't in the mandatory items list. Footer intentionally
    // empty for Buseko CN reprints â€” all CN metadata lives at the top.
    const nonFiscalCnFooter = '';

    // v1.13.128e â€” Framed banner shows the base document type only.
    // Reprint marking is handled by the *** COPY / DUPLICATE *** band
    // above (per user preference â€” same layout that was working before).
    // "(Provisional)" wording dropped for CN â€” never a ZRA requirement.
    // v1.13.15x â€” Dropped "Original" prefix on the signed title. ZRA's own
    // Accounting Package Self-Check form (item 4i) only mandates the words
    // "tax invoice" be shown prominently â€” "Original" was never required
    // and, worse, contradicted the reprint's own "This is a reprint â€” not
    // the original tax invoice" subtitle directly below it. POS.js's live
    // first-print template already prints plain "TAX INVOICE" for the
    // signed case â€” this brings the reprint template in line with it.
    const title = isCreditNote ? 'Tax Credit Note' : 'Tax Invoice';

    // 2026-09-10 â€” on a POS small terminal (System Settings â†’ Device type)
    // the reprint comes out on 58mm. Same figures, same flags and the same
    // title-block order as the 80mm reprint below; only the layout differs.
    if (isTerminal58()) {
      const bands = [`*** ${title.toUpperCase()} ***`];
      if (isCnReprint || isInvReprint) bands.push('*** COPY / DUPLICATE ***');
      if (isCnReprint)  bands.push({ text: 'This is a reprint of the credit note', sub: true });
      if (isInvReprint) bands.push({ text: 'This is a reprint â€” not the original tax invoice', sub: true });
      if (isCreditNote) bands.push({ text: `Reverses invoice ${origRcptRef}`, sub: true });
      if (!isCreditNote && order.status === 'Reversed') bands.push('*** REVERSED ***');
      if (!isCreditNote && order.status === 'Partial')  bands.push('*** PARTIALLY REVERSED ***');

      const reasonText = `${cnReasonCd} â€” ${cnReasonLbl}`
        + ((order.zra_cn_rfd_rsn_other && cnReasonCd === '07') ? ` (${order.zra_cn_rfd_rsn_other})` : '');
      const v = order.empty_voucher;
      const vQty = v ? (parseInt(v.qty_claimed, 10) || 0) : 0;
      const showFiscal = isSigned && !isCnNonFiscal;

      return buildReceipt58({
        title: `${title} ${rcptRef}`,
        bizLines: ['RED SEA IMPORT & EXPORT', '(Z) LIMITED'],
        address: bAddress, tpin: businessTpin, phone: bPhone,
        money: rcptMoney,
        bands,
        meta: [
          { label: 'Cashier:', value: String(cashierName || '').toUpperCase(), bold: true },
          ...(branchDepotId ? [{ label: 'Branch:', value: branchDepotId }] : []),
          { label: isCreditNote ? 'Credit Note #:' : 'Invoice #:', value: rcptRef },
          ...(isCreditNote ? [{ label: 'Reason:', value: reasonText }] : []),
          { label: 'Date:', value: dateStr },
          // Buyer lines only for a named customer, or a walk-in who gave a
          // TPIN; a plain walk-in's default TPIN is still in the ZRA block.
          ...((!order.customer_tpin
                && (!order.customer_name || /^walk[\s-]?in/i.test(String(order.customer_name).trim())))
            ? []
            : [
              { label: 'Buyer TPIN:', value: buyerTpin },
              { label: 'Buyer Name:', value: order.customer_name || 'Walk-in' },
            ]),
          ...(order.customer_address ? [{ label: 'Address:', value: order.customer_address }] : []),
          ...(order.lpo_number ? [{ label: 'LPO No.:', value: order.lpo_number, mono: true, bold: true }] : []),
          { label: 'Currency:', value: 'ZMW' },
        ],
        lines: lines58,
        totals: [
          { label: 'Total (Excl. Tax)', value: rcptMoney(totalNet) },
          { label: 'VAT',               value: rcptMoney(totalVat) },
          { label: isCreditNote ? 'Amount Refunded ZMW' : 'Amount Due ZMW', value: rcptMoney(order.total_amount), strong: true },
          { label: 'Cash Tendered',     value: rcptMoney(tendered) },
          { label: 'Cash Change',       value: rcptMoney(Math.max(0, change)) },
        ],
        empties: v && v.voucher_number && vQty > 0 ? { voucher: v.voucher_number, qty: vQty } : null,
        qrDataUrl: showFiscal ? qrDataUrl : '',
        fiscal: showFiscal ? [
          { label: 'Receipt Number:', value: rcptRef },
          { label: 'Security Data:',  value: fmtCode(intrlActive) },
          { label: 'VSDC Time:',      value: fmtCode(pbctActive) },
          { label: 'Signature:',      value: fmtCode(signActive) },
          { label: 'Serial No.',      value: fmtCode(deviceSerialNo) },
          { label: 'sdcId',           value: fmtCode(sdcIdActive) },
          ...(isCreditNote ? [
            { label: 'Original Invoice:', value: origRcptRef },
            { label: 'Reason:',           value: `${cnReasonCd} â€” ${cnReasonLbl}` },
          ] : []),
        ] : null,
        fiscalTail: ['Cash Sales', `CUSTOMER TPIN ${buyerTpin}`],
        footer: 'Thank you for your purchase.',
      });
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  /* 2026-08-30 â€” 72mm, NOT 80mm. 80mm is the width of the PAPER; the print
     head only covers 72mm. The driver says so itself: its paper setting
     reads "ZPrinter Paper(80(72) x 3276mm)" â€” 80mm roll, 72mm printable.
     Declaring 80mm made Chrome lay the receipt out 8mm wider than the
     printer can reach, and the driver simply dropped the overhang. Every
     line lost the same three or four characters off the right: Walk-i(n),
     ZM(W), INV0060001067/9(0), 77.3(7). It read as a table problem, but the
     header and totals were clipped too â€” the canvas was just too wide.
     Matching the canvas to the print head means nothing can fall off. */
  @page { size: 72mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; overflow-x: hidden; }
  * { box-sizing: border-box; }
  body {
    width: 72mm; max-width: 72mm;
    /* 2026-09-01 â€” was padding: 2mm all round. The left edge printed off
       the paper: RED SEA came out as ED SEA, Cashier as ashier. The page
       is exactly 72mm (box-sizing is border-box above), so nothing is
       overflowing â€” the print head simply starts a couple of millimetres
       right of where the browser puts x=0. Moving the padding from the
       right side to the left shifts the content across without making
       the content area any narrower: 4 + 0 is the same 4mm as 2 + 2.
       If the left is STILL clipped, raise the 4mm. If the right now
       clips instead, lower it. */
    /* 2026-09-02 â€” matched to POS.js. At 4mm left with no right padding the
       content ran to the print head's last dot and the header lost its
       closing bracket: RED SEA IMPORT & EXPORT (2 */
    /* 2026-09-02 â€” 3mm/2mm -> 2mm/3mm. Same 67mm of content, moved 1mm
       left because the right edge was still shaving the last digit.
       2mm on the left is what clipped the LEFT edge back in v1.13.87,
       so this is the end of what shifting can do: if the left starts
       cutting now, the fix is narrower content, not more offset. */
    padding: 2mm 3mm 2mm 2mm;
    /* 2026-09-01 â€” was 'Courier New' at weight 700 throughout.
       Two separate problems, one line of CSS. Courier is monospace, so a
       thin 'i' claims the same width as a 'W' and the 38px description
       column held about seven characters: "Appletiser/Grapetiser 300ml"
       printed as Applet / iser/G / rapeti / ser / 300ml. And weight 700 at
       9px merges adjacent dots on a 203dpi head, which is what made it look
       smeared rather than merely small.
       Arial is proportional and averages 4.3px per character against
       Courier's fixed 5.4px â€” roughly a quarter more text per line â€” and
       normal weight keeps the strokes separate. Bold is kept where it now
       means something: column headers, Amount Due, the business name and
       the invoice title. */
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
    font-size: 11px; color: #000; font-weight: 400;
  }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }

  td { padding: 1px 0; vertical-align: top; }
  /* Keep header/metadata + amount-block labels on ONE line â€” long
     values (invoice #, address) were making the browser squeeze the
     first column and wrap "Buyer TPIN:" / "Buyer Name:" mid-label.
     Scoped to first-child in non-.items tables so item description
     cells (which need to wrap on spaces) are unaffected. */
  table:not(.items) tr > td:first-child { white-space: nowrap; }
  /* 2026-08-30 â€” THIS is why the right-hand side kept getting cut, and why
     narrowing the page did not help.
     width:100% on a table is only a SUGGESTION under the default
     table-layout:auto. The browser will grow a table past 100% when its
     content demands it â€” and here it did: the label column is nowrap, and
     values like INV0060001067/90 or 1000000000 have no spaces, so they
     cannot wrap either. The single widest row therefore set the width of
     the WHOLE table, and because columns are shared across rows, every
     right-aligned value shifted outward together and off the paper.
     That is exactly the gap in the middle of each row â€” the table stretched
     wider than the receipt and pushed the right column out with it.
     Ordinary centred text ("This is a reprint...") was never affected,
     because a div simply wraps inside the body. That difference is what
     gave it away.
     Letting the value column break anywhere removes the minimum width that
     was forcing the overflow; the table can then honour 100%. */
  /* 2026-08-30 â€” tables stop at 86% of the body. The remaining 14% is
     deliberately never printed on.
     Four earlier attempts tried to make the content FIT inside 100% â€”
     narrower page, narrower columns, smaller font, wrapping cells. But 100%
     is where the loss happens: a right-aligned value sits on the print
     head's last dot, and that dot is unreliable. It is why even 77.37 came
     out as 77.3 while the centred lines beside it printed in full.
     The reference receipt this was compared against does the same thing â€”
     its item table visibly stops well short of the edge. Leaving slack means
     an overflow eats into the margin instead of falling off the paper, and
     the Total column â€” the number that matters most and was always last in
     the row â€” is no longer the one closest to the cut. */
  /* 2026-09-02 â€” was 86%, which left 13.5mm of printable paper blank while
     the money columns were too narrow for their own figures. The gutter
     below keeps the Total off the print head's last dot. */
  table { width: 100%; max-width: 100%; }
  table:not(.items) tr > td:last-child { overflow-wrap: anywhere; word-break: break-word; }
  /* The item table has explicit colgroup widths, so pin the layout to them
     rather than letting the widest number stretch the lot. */
  .items { table-layout: fixed; }
  /* 2026-08-30 â€” item cells must WRAP, not overflow.
     table-layout:fixed pins each column to its colgroup width, but a value
     wider than its cell then spills over the next column instead of being
     clipped. On a K306,000 sale that produced
        AQUA  B 3400263,042.7d6% 42,957.206,000.00
     â€” quantity welded to VAT-exclusive, the rate mangled, the total
     unreadable. The earlier overflow-wrap rule was scoped to
     table:not(.items), so the one table that most needed it was excluded.
     Wrapping puts the tail on a second line, exactly as the reference
     receipt does with 1,384.49. */
  /* 2026-09-02 â€” anywhere shredded product names a character at a time.
     Kept on the numeric cells, where it stops a long figure widening the
     table. */
  .items td.n { overflow-wrap: anywhere; word-break: break-word; }
  .items td   { overflow-wrap: break-word; }
  .c { text-align: center; }
  .divider { text-align: center; font-size: 10px; overflow: hidden; white-space: nowrap; margin: 3px 0; }
  .items { font-size: 9px; }
  /* v1.13.97 â€” fixed column widths + Qt right-padding so numeric
     columns don't visually bleed into each other (see POS.js). */
  /* 2026-09-01 â€” tabular figures at the table level, not just on .n.
     The plain-slip builder right-aligns its numbers with inline styles
     and has no .n rule at all, so a .n-scoped declaration reached the
     tax invoice and silently missed the slip. Digits only â€” letters are
     unaffected, so applying it to every cell is safe. */
  .items td { padding: 1px 1px; font-variant-numeric: tabular-nums; }
  .items thead td { font-weight: 700; border-bottom: 1px solid #000; }
  .items col.desc  { width: auto; }
  /* 2026-08-30 â€” narrowed so the table fits 80mm paper, and kept IDENTICAL
     to the POS slip: both render the same seven columns, so the reprint
     must not lay out differently from the original.
     Was 18+22+50+44+28+46 = 208px of fixed columns plus 28px of cell
     padding inside a 246px body â€” about 10px left for the product name.
     The browser widened the table past the paper and sliced the right-hand
     column, which is why invoice numbers and totals printed truncated.
     The col.rrp rule that used to sit here matched nothing: RRP is used in
     the MTV maths but has never been a printed column. Removed. */
  /* 2026-09-02 â€” same widths as POS.js so an invoice and its reprint are
     identical. Sized for 186,000.00 at 9px, which measures 45px. */
  .items col.vat   { width: 47px; }  /* v1.13.137 â€” new VAT amount */
  .items col.rate  { width: 20px; }  /* Cat header (D/B/A) */
  .items col.qt    { width: 22px; }  /* holds 4 digits */
  .items col.net   { width: 47px; }  /* 186,000.00 */
  .items col.tax   { width: 20px; }  /* Rate header (16%/0%) */
  .items col.total { width: 47px; }
  /* The gutter that replaces the old 86%. */
  tr > td:last-child { padding-right: 6px; }
  /* v1.13.128d â€” Anthony post-UAT: headers centered above right-aligned
     numeric data. Data still right-aligned so decimals line up.
     VAT Excl column widened to 50px so the label doesn't wrap onto
     two lines. */
  .items thead td.n { text-align: center; }
  /* 2026-08-30 â€” TOP, not middle. The description and Cat cells inherit
     vertical-align: top, so on a product name that wraps to two lines the
     numbers alone drifted to the centre of the taller row: "AQUA CLEAR /
     1000mls" printed with B level with line one and 1 / 77.37 / 16% /
     12.63 / 90.00 sitting between the two. Identical on a one-line name,
     which is why it went unnoticed. */
  .items tbody td.n { text-align: right; padding-right: 3px; vertical-align: top;
                      font-variant-numeric: tabular-nums; }
  .amtline td { font-size: 12px; font-variant-numeric: tabular-nums; }
  /* 2026-09-02 â€” Courier dropped so the fiscal block matches the rest of
     the receipt. It was monospace on purpose: Security Data and Signature
     are long random strings and a fixed pitch makes them easier to read
     back character by character during an audit. Put the font-family line
     back if that ever matters more than the look. */
  .fisc { font-size: 9px; word-break: break-all; }
  /* v1.13.128g â€” Title block sits between two dashed dividers. Contains
     the document title + (on reprints) COPY/DUPLICATE + informational
     subtitle. No borders on the title itself â€” the dividers frame it. */
  .invoice-title { text-align: center; font-weight: 800; font-size: 13px; letter-spacing: 2px; margin: 2px 0; text-transform: uppercase; }
  .invoice-dup   { text-align: center; font-weight: 800; font-size: 12px; margin: 2px 0; }
  .invoice-sub   { text-align: center; font-size: 10px; margin: 1px 0; }
</style>
</head>
<body>
  <div class="c" style="font-size:13px;font-weight:800;letter-spacing:1px;">RED SEA IMPORT &amp; EXPORT (Z) LIMITED</div>
  ${businessTpin ? `<div class="c" style="font-size:11px;">TPIN: ${businessTpin}</div>` : ''}
  ${isSigned && order.zra_sdc_id ? `<div class="c" style="font-size:11px;">sdcId ${order.zra_sdc_id}</div>` : ''}
  ${bAddress ? `<div class="c" style="font-size:11px;">${String(bAddress).replace(/\n/g, '<br/>').toUpperCase()}</div>` : ''}
  ${bPhone ? `<div class="c" style="font-size:11px;">Tel: ${bPhone}</div>` : ''}

  <!-- v1.13.128h â€” Title block between THICK dividers (=== not ---).
       Order inside the block:
         1. *** TAX INVOICE ***  (or *** TAX CREDIT NOTE ***)
         2. *** COPY / DUPLICATE ***          (reprints only)
         3. "This is a reprint..." subtitle   (reprints only)
         4. "Reverses invoice INV-..."        (CN only, always)
       Cashier + Branch/Depot follow below as right-aligned table rows
       to match Buyer TPIN / Buyer Name style. -->
  <div class="divider">${div42eq}</div>
  <div class="invoice-title">*** ${title.toUpperCase()} ***</div>
  ${(isCnReprint || isInvReprint) ? `<div class="invoice-dup">*** COPY / DUPLICATE ***</div>` : ''}
  ${isCnReprint ? `<div class="invoice-sub">This is a reprint of the credit note</div>` : ''}
  ${isInvReprint ? `<div class="invoice-sub">This is a reprint &mdash; not the original tax invoice</div>` : ''}
  ${isCreditNote ? `<div class="invoice-sub">Reverses invoice ${origRcptRef}</div>` : ''}
  ${(!isCreditNote && order.status === 'Reversed') ? `<div class="invoice-dup">*** REVERSED ***</div>` : ''}
  ${(!isCreditNote && order.status === 'Partial') ? `<div class="invoice-dup">*** PARTIALLY REVERSED ***</div>` : ''}
  <div class="divider">${div42eq}</div>

  <table>
    <tr><td>Cashier:</td>
        <td style="text-align:right;font-weight:700;">${String(cashierName || '').toUpperCase()}</td></tr>
    ${branchDepotId ? `<tr><td>Branch:</td><td style="text-align:right;">${branchDepotId}</td></tr>` : ''}
    <tr><td>${isCreditNote ? 'Credit Note #:' : 'Invoice #:'}</td>
        <td style="text-align:right;font-family:monospace;font-size:10px;">${rcptRef}</td></tr>
    ${isCreditNote ? `<tr><td>Reason:</td><td style="text-align:right;">${cnReasonCd} â€” ${cnReasonLbl}${(order.zra_cn_rfd_rsn_other && cnReasonCd === '07') ? ' (' + String(order.zra_cn_rfd_rsn_other).replace(/</g, '&lt;') + ')' : ''}</td></tr>` : ''}
    <tr><td>Date:</td>
        <td style="text-align:right;">${dateStr}</td></tr>
    <tr><td>Buyer TPIN:</td>
        <td style="text-align:right;font-family:monospace;">${buyerTpin}</td></tr>
    <tr><td>Buyer Name:</td>
        <td style="text-align:right;">${String(order.customer_name || 'Walk-in').replace(/</g, '&lt;')}</td></tr>
    ${order.customer_address ? `<tr><td>Address:</td><td style="text-align:right;">${String(order.customer_address).replace(/</g, '&lt;')}</td></tr>` : ''}
    ${order.lpo_number ? `<tr><td>LPO No.:</td><td style="text-align:right;font-family:monospace;font-weight:700;">${String(order.lpo_number).replace(/</g, '&lt;')}</td></tr>` : ''}
    <tr><td>Currency:</td><td style="text-align:right;">ZMW</td></tr>
  </table>

  <div class="divider">${div42eq}</div>
  <table class="items">
    <colgroup>
      <col class="desc" />
      <col class="rate" />
      <col class="qt" />
      <col class="net" />
      <col class="tax" />
      <col class="vat" />
      <col class="total" />
    </colgroup>
    <thead>
      <tr>
        <td>Descr</td>
        <td style="text-align:center;">Cat</td>
        <td class="n">Qt</td>
        <td class="n">VAT Excl</td>
        <td class="n">Rate</td>
        <td class="n">VAT</td>
        <td class="n">Total</td>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>
  <div class="divider">${div42da}</div>

  <table>
    <tr class="amtline"><td>Total (Excl. Tax)</td><td style="text-align:right;">${rcptMoney(totalNet)}</td></tr>
    <tr class="amtline"><td>VAT</td><td style="text-align:right;">${rcptMoney(totalVat)}</td></tr>
    ${/* MTV Uplift (Absorbed) removed per user 2026-08-18 to match POS.js
        receipt templates. Same JSX block feeds ALL Sales Report reprints:
        invoice reprint (COPY/DUPLICATE), Credit Note, and reversed invoice
        reprint (REVERSED band) â€” all three suppress the uplift row together.
        totalMtvUplift is still computed above so a future internal-only
        report can surface the absorbed uplift for margin-erosion analysis.
        See ZRA Accounting Package Self-Declaration Q4(viii)/(ix): only
        Excl Tax, discount, total tax, and Incl Tax are mandated. */ ''}
    <tr class="amtline"><td style="font-weight:800;">${isCreditNote ? 'Amount Refunded  ZMW' : 'Amount Due  ZMW'}</td>
        <td style="text-align:right;font-weight:800;">${rcptMoney(order.total_amount)}</td></tr>
    <tr class="amtline"><td>Cash Tendered</td><td style="text-align:right;">${rcptMoney(tendered)}</td></tr>
    <tr class="amtline"><td>Cash Change</td><td style="text-align:right;">${rcptMoney(Math.max(0, change))}</td></tr>
  </table>${emptiesBlock(order, div42da)}
  <table>
  </table>
  ${fiscalFooter}
  ${nonFiscalCnFooter}
  <div class="c" style="margin-top:4px;font-size:10px;">Thank you for your purchase.</div>
</body>
</html>`;
  };

  // v1.13.100 â€” Tax Debit Note reprint (T08A #14). Distinct template
  // because DN fiscal data lives on the debit_notes row, not the order.
  // Layout mirrors buildColumnarReprintHtml so a stack of Invoice /
  // Credit Note / Debit Note reprints reads consistently on the 80mm
  // roll. dn is a row from GET /orders/:id/debit-notes.
  const buildDebitNoteHtml = async (order, dn) => {
    if (!dn) return '';
    const dnSigned = !!dn.zra_rcpt_no && dn.zra_status === 'SIGNED';
    const div42eq = '='.repeat(42);
    const div42da = '-'.repeat(42);
    const fmtCode = (s) => (s ? String(s) : 'â€”');
    const buyerTpin = order?.customer_tpin || dn.customer_tpin || '1000000000';
    const bName = businessName;
    const bAddress = businessAddress;
    const bPhone = businessPhone;
    const cashierName = dn.created_by_name || order?.served_by || 'Staff';

    const amount = parseFloat(dn.amount || 0);
    const vat    = amount - amount / 1.16;
    const descr  = (dn.notes || 'Additional charge').replace(/</g, '&lt;');

    // DN's own receipt ref uses DBT prefix. Cross-ref points at the
    // original invoice this DN is issued against.
    const sdcSuffix = String(dn.zra_sdc_id || '').replace(/^SDC/i, '');
    const rcptRef   = dnSigned
      ? (dn.zra_cis_invc_no
          ? `DBT${sdcSuffix}/${dn.zra_rcpt_no}`
          : `DBT${sdcSuffix}/${dn.zra_rcpt_no}`)
      : fmtCode(dn.dn_number);
    // v1.13.148 â€” same rcptNo-first rule for DN's original-invoice ref.
    const origSdcSuffix = String(order?.zra_sdc_id || dn.zra_org_sdc_id || '').replace(/^SDC/i, '');
    const origRcptNoRef = order?.zra_rcpt_no || dn.zra_org_rcpt_no;
    const origRcptRef   = origRcptNoRef
      ? `INV${origSdcSuffix}/${origRcptNoRef}`
      : fmtCode(order?.order_number || dn.orig_order_number);
    const reasonCd  = dn.reason_cd || dn.zra_dbt_rsn_cd || '07';
    const reasonLbl = CN_REASON_LABEL[reasonCd] || 'Other';

    let qrDataUrl = '';
    if (dnSigned && dn.zra_qr_code_url) {
      try {
        qrDataUrl = await QRCode.toDataURL(dn.zra_qr_code_url, { width: 180, margin: 1, errorCorrectionLevel: 'M' });
      } catch (_) { /* signature block still prints */ }
    }

    const dt = new Date(((dn.date || dn.created_at || '') + '').includes('T') ? dn.created_at : (dn.date + 'T00:00:00Z'));
    const dateStr = isNaN(dt.getTime()) ? (dn.date || '') : dt.toLocaleDateString('en-GB');

    const reprintBand = `<div class="c" style="font-weight:800;font-size:12px;color:#000;">*** TAX DEBIT NOTE ***</div>
       <div class="c" style="font-size:10px;">Additional charge on invoice ${origRcptRef}</div>`;

    const fiscalFooter = dnSigned ? `
  <div class="divider">${div42eq}</div>
  ${qrDataUrl ? `<div class="c" style="margin:4px 0;"><img src="${qrDataUrl}" style="width:38mm;height:38mm;" alt="QR" /></div>` : ''}
  <div class="divider">${div42eq}</div>
  <table class="fisc">
    <tr><td>Receipt Number:</td><td style="text-align:right;">${rcptRef}</td></tr>
    <tr><td colspan="2">Security Data:</td></tr>
    <tr><td colspan="2">${fmtCode(dn.zra_intrl_data)}</td></tr>
    <tr><td>VSDC Time:</td><td style="text-align:right;">${fmtCode(dn.zra_vsdc_rcpt_pbct_date)}</td></tr>
    <tr><td>Signature:</td><td style="text-align:right;">${fmtCode(dn.zra_rcpt_sign)}</td></tr>
    <tr><td>Serial No.</td><td style="text-align:right;">${fmtCode(deviceSerialNo)}</td></tr>
    <tr><td colspan="2">sdcId ${fmtCode(dn.zra_sdc_id)}</td></tr>
    <tr><td colspan="2" style="padding-top:3px;">Original Invoice:</td></tr>
    <tr><td colspan="2">${origRcptRef}</td></tr>
    <tr><td>Reason:</td><td style="text-align:right;">${reasonCd} â€” ${reasonLbl}</td></tr>
    <tr><td colspan="2" style="padding-top:3px;">Cash Sales</td></tr>
    <tr><td colspan="2">CUSTOMER TPIN ${buyerTpin}</td></tr>
  </table>` : `<div class="divider">${div42eq}</div>`;

    // v1.13.101 â€” ZRA T08A page 14 says the DN "must read 'Debit Note'"
    // (unlike CN which is "Tax Credit Note"). Dropped the "Tax" prefix.
    // v1.13.128d â€” "(Provisional)" removed everywhere per user; a DN is a
    // DN whether VSDC-signed or not. Adaptive "Copy of" prefix would be
    // added here if/when a reprint flow exists for DNs (not today).
    const title = 'Debit Note';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  /* 2026-08-30 â€” 72mm, NOT 80mm. 80mm is the width of the PAPER; the print
     head only covers 72mm. The driver says so itself: its paper setting
     reads "ZPrinter Paper(80(72) x 3276mm)" â€” 80mm roll, 72mm printable.
     Declaring 80mm made Chrome lay the receipt out 8mm wider than the
     printer can reach, and the driver simply dropped the overhang. Every
     line lost the same three or four characters off the right: Walk-i(n),
     ZM(W), INV0060001067/9(0), 77.3(7). It read as a table problem, but the
     header and totals were clipped too â€” the canvas was just too wide.
     Matching the canvas to the print head means nothing can fall off. */
  @page { size: 72mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; overflow-x: hidden; }
  * { box-sizing: border-box; }
  body {
    width: 72mm; max-width: 72mm;
    /* 2026-09-01 â€” was padding: 2mm all round. The left edge printed off
       the paper: RED SEA came out as ED SEA, Cashier as ashier. The page
       is exactly 72mm (box-sizing is border-box above), so nothing is
       overflowing â€” the print head simply starts a couple of millimetres
       right of where the browser puts x=0. Moving the padding from the
       right side to the left shifts the content across without making
       the content area any narrower: 4 + 0 is the same 4mm as 2 + 2.
       If the left is STILL clipped, raise the 4mm. If the right now
       clips instead, lower it. */
    padding: 2mm 0 2mm 4mm;
    /* 2026-09-01 â€” was 'Courier New' at weight 700 throughout.
       Two separate problems, one line of CSS. Courier is monospace, so a
       thin 'i' claims the same width as a 'W' and the 38px description
       column held about seven characters: "Appletiser/Grapetiser 300ml"
       printed as Applet / iser/G / rapeti / ser / 300ml. And weight 700 at
       9px merges adjacent dots on a 203dpi head, which is what made it look
       smeared rather than merely small.
       Arial is proportional and averages 4.3px per character against
       Courier's fixed 5.4px â€” roughly a quarter more text per line â€” and
       normal weight keeps the strokes separate. Bold is kept where it now
       means something: column headers, Amount Due, the business name and
       the invoice title. */
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
    font-size: 11px; color: #000; font-weight: 400;
  }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }

  td { padding: 1px 0; vertical-align: top; }
  /* Keep header/metadata + amount-block labels on ONE line â€” long
     values (invoice #, address) were making the browser squeeze the
     first column and wrap "Buyer TPIN:" / "Buyer Name:" mid-label.
     Scoped to first-child in non-.items tables so item description
     cells (which need to wrap on spaces) are unaffected. */
  table:not(.items) tr > td:first-child { white-space: nowrap; }
  /* 2026-08-30 â€” THIS is why the right-hand side kept getting cut, and why
     narrowing the page did not help.
     width:100% on a table is only a SUGGESTION under the default
     table-layout:auto. The browser will grow a table past 100% when its
     content demands it â€” and here it did: the label column is nowrap, and
     values like INV0060001067/90 or 1000000000 have no spaces, so they
     cannot wrap either. The single widest row therefore set the width of
     the WHOLE table, and because columns are shared across rows, every
     right-aligned value shifted outward together and off the paper.
     That is exactly the gap in the middle of each row â€” the table stretched
     wider than the receipt and pushed the right column out with it.
     Ordinary centred text ("This is a reprint...") was never affected,
     because a div simply wraps inside the body. That difference is what
     gave it away.
     Letting the value column break anywhere removes the minimum width that
     was forcing the overflow; the table can then honour 100%. */
  /* 2026-08-30 â€” tables stop at 86% of the body. The remaining 14% is
     deliberately never printed on.
     Four earlier attempts tried to make the content FIT inside 100% â€”
     narrower page, narrower columns, smaller font, wrapping cells. But 100%
     is where the loss happens: a right-aligned value sits on the print
     head's last dot, and that dot is unreliable. It is why even 77.37 came
     out as 77.3 while the centred lines beside it printed in full.
     The reference receipt this was compared against does the same thing â€”
     its item table visibly stops well short of the edge. Leaving slack means
     an overflow eats into the margin instead of falling off the paper, and
     the Total column â€” the number that matters most and was always last in
     the row â€” is no longer the one closest to the cut. */
  table { width: 86%; max-width: 86%; }
  table:not(.items) tr > td:last-child { overflow-wrap: anywhere; word-break: break-word; }
  /* The item table has explicit colgroup widths, so pin the layout to them
     rather than letting the widest number stretch the lot. */
  .items { table-layout: fixed; }
  /* 2026-08-30 â€” item cells must WRAP, not overflow.
     table-layout:fixed pins each column to its colgroup width, but a value
     wider than its cell then spills over the next column instead of being
     clipped. On a K306,000 sale that produced
        AQUA  B 3400263,042.7d6% 42,957.206,000.00
     â€” quantity welded to VAT-exclusive, the rate mangled, the total
     unreadable. The earlier overflow-wrap rule was scoped to
     table:not(.items), so the one table that most needed it was excluded.
     Wrapping puts the tail on a second line, exactly as the reference
     receipt does with 1,384.49. */
  .items td { overflow-wrap: anywhere; word-break: break-word; }
  .c { text-align: center; }
  .divider { text-align: center; font-size: 10px; overflow: hidden; white-space: nowrap; margin: 3px 0; }
  .items { font-size: 9px; }
  /* 2026-09-01 â€” tabular figures at the table level, not just on .n.
     The plain-slip builder right-aligns its numbers with inline styles
     and has no .n rule at all, so a .n-scoped declaration reached the
     tax invoice and silently missed the slip. Digits only â€” letters are
     unaffected, so applying it to every cell is safe. */
  .items td { padding: 1px 1px; font-variant-numeric: tabular-nums; }
  .items thead td { font-weight: 700; border-bottom: 1px solid #000; }
  .amtline td { font-size: 12px; font-variant-numeric: tabular-nums; }
  .fisc { font-size: 9px; font-family: 'Courier New', Courier, monospace; word-break: break-all; }
  /* v1.13.128g â€” same title-block style as invoices / credit notes. */
  .invoice-title { text-align: center; font-weight: 800; font-size: 13px; letter-spacing: 2px; margin: 2px 0; text-transform: uppercase; }
  .invoice-dup   { text-align: center; font-weight: 800; font-size: 12px; margin: 2px 0; }
</style>
</head>
<body>
  <div class="c" style="font-size:13px;font-weight:800;letter-spacing:1px;">RED SEA IMPORT &amp; EXPORT (Z) LIMITED</div>
  ${businessTpin ? `<div class="c" style="font-size:11px;">TPIN: ${businessTpin}</div>` : ''}
  ${dnSigned && dn.zra_sdc_id ? `<div class="c" style="font-size:11px;">sdcId ${dn.zra_sdc_id}</div>` : ''}
  ${bAddress ? `<div class="c" style="font-size:11px;">${String(bAddress).replace(/\n/g, '<br/>').toUpperCase()}</div>` : ''}
  ${bPhone ? `<div class="c" style="font-size:11px;">Tel: ${bPhone}</div>` : ''}

  <!-- v1.13.128h â€” Title block between THICK dividers, matching the
       Invoice / CN templates. Simpler here (no MTV, no reprint). -->
  <div class="divider">${div42eq}</div>
  <div class="invoice-title">*** ${title.toUpperCase()} ***</div>
  <div class="divider">${div42eq}</div>
  <table>
    <tr><td>Cashier:</td>
        <td style="text-align:right;font-weight:700;">${String(cashierName || '').toUpperCase()}</td></tr>
    <tr><td>Invoice #:</td>
        <td style="text-align:right;font-family:monospace;font-size:10px;">${rcptRef}</td></tr>
    <tr><td>Date:</td>
        <td style="text-align:right;">${dateStr}</td></tr>
    <tr><td>DN Number:</td>
        <td style="text-align:right;font-family:monospace;">${fmtCode(dn.dn_number)}</td></tr>
    <tr><td>Buyer TPIN:</td>
        <td style="text-align:right;font-family:monospace;">${buyerTpin}</td></tr>
    <tr><td>Buyer Name:</td>
        <td style="text-align:right;">${String(order.customer_name || 'Walk-in').replace(/</g, '&lt;')}</td></tr>
    ${order.customer_address ? `<tr><td>Address:</td><td style="text-align:right;">${String(order.customer_address).replace(/</g, '&lt;')}</td></tr>` : ''}
    <tr><td>Currency:</td><td style="text-align:right;">ZMW</td></tr>
  </table>

  <div class="divider">${div42eq}</div>
  <table class="items">
    <thead>
      <tr>
        <td>Descr</td>
        <td style="text-align:center;">Rate</td>
        <td style="text-align:right;">Qt</td>
        <td style="text-align:right;">Price</td>
        <td style="text-align:right;">Tax</td>
        <td style="text-align:right;">Total</td>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="word-break:break-word;">${descr}</td>
        <td style="text-align:center;">A</td>
        <td style="text-align:right;">1</td>
        <td style="text-align:right;">${amount.toFixed(2)}</td>
        <td style="text-align:right;">16%</td>
        <td style="text-align:right;">${amount.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>
  <div class="divider">${div42da}</div>

  <table>
    <tr class="amtline"><td>VAT</td><td style="text-align:right;">${rcptMoney(vat)}</td></tr>
    <tr class="amtline"><td style="font-weight:800;">Additional Charge  ZMW</td>
        <td style="text-align:right;font-weight:800;">${amount.toFixed(2)}</td></tr>
  </table>
  ${fiscalFooter}
  <div class="c" style="margin-top:4px;font-size:10px;">Please settle this additional charge.</div>
</body>
</html>`;
  };

  // v1.13.100 â€” Print handler for a debit note. Fetches the DN row from
  // the backend by orderId (list) and prints the newest one, or accepts
  // an already-hydrated DN row via opts.dn to avoid the extra fetch.
  const handlePrintDebitNote = async (order, dn) => {
    try {
      let dnRow = dn;
      if (!dnRow) {
        const { data } = await getOrderDebitNotes(order.id);
        if (!Array.isArray(data) || data.length === 0) {
          alert('No debit notes on this order yet.');
          return;
        }
        dnRow = data[0]; // newest first â€” created_at DESC on server
      }
      const html = await buildDebitNoteHtml(order, dnRow);
      printDirect(html);
    } catch (err) {
      console.error('[SalesReport] debit-note print failed:', err);
      alert('Failed to render the Debit Note.');
    }
  };

  // Explicit "Download PDF" path â€” skips the backend ESC/POS attempt and
  // goes straight to PDF generation. Shown only when the user picked PDF
  // Download in System Settings AND is on a phone-sized screen.
  const handleDownloadPdfReceipt = (order) => {
    const html = buildReceiptHtml(order);
    downloadPdf(html);
  };

  // Build the 80mm thermal-receipt HTML used by both the print fallback
  // and the explicit Download PDF button. Single source of truth so the
  // two paths produce identical output.
  const buildReceiptHtml = (order, opts = {}) => {
    // v1.13.37 â€” isReprint flag (ZRA checklist #24). When true, the
    // "SALES RECEIPT" title band is replaced with "*** COPY /
    // DUPLICATE ***" and a subtitle explaining it's not the original.
    const isReprint = !!opts.isReprint;
    const div = '='.repeat(42);
    const fmt2 = (n) => (parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmt0 = (n) => (parseFloat(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    // v1.10.63 â€” track whether any line was sold in a non-default unit
    // so we can print the "** sold in alternate unit" legend at the
    // bottom, matching POS.js.
    let hasAltUnit = false;
    // v1.10.59/63 â€” Liquor keeps its 2-line format with PRICE and TOTAL
    // columns (matches ESC/POS backend and POS.js till receipt). Kelete
    // renders Name + Qty only per the dual-currency redesign.
    const itemRows = (order.items || []).map(item => {
      const origQty = parseFloat(item.quantity || 0);
      const rq      = parseFloat(item.reversed_quantity || 0);
      const partial = !item.reversed && rq > 0;
      const netQty  = partial ? Math.max(0, origQty - rq) : origQty;
      const unitPx  = parseFloat(item.unit_price || 0);
      const netTotal = partial ? unitPx * netQty : parseFloat(item.total_price || 0);
      // Same non-default-unit flag as the on-page receipt.
      const dispUnit = pickDisplayUnit(item);
      let hasMultiUnits = false;
      try {
        const arr = item.units_json ? JSON.parse(item.units_json) : null;
        if (Array.isArray(arr) && arr.length > 1) hasMultiUnits = true;
      } catch { /* ignore */ }
      if (!hasMultiUnits && item.alt_unit && item.alt_unit !== item.product_base_unit) hasMultiUnits = true;
      const soldInNonDefault = hasMultiUnits && item.unit && dispUnit.name && item.unit !== dispUnit.name;
      if (soldInNonDefault) hasAltUnit = true;
      const marker = soldInNonDefault ? ' **' : '';
      const rowWeight = soldInNonDefault ? 'font-weight:700;' : '';
      const nameLabel = item.product_name + (item.reversed ? ' [VOID]' : '') + marker;
      if (!isLiquorStyle) {
        // Kelete: Name + Qty only, single row per item.
        const partialNoteKelete = partial ? `<tr><td colspan="2" style="font-size:9px;color:#b45309;padding-left:6px">was ${origQty} ${item.unit || ''} â€” reversed ${rq}</td></tr>` : '';
        return `
        <tr style="${rowWeight}${item.reversed ? 'text-decoration:line-through;color:#999;' : ''}">
          <td style="font-weight:700;padding-top:4px;">${nameLabel}</td>
          <td style="text-align:right;white-space:nowrap;padding-top:4px;">${netQty} ${item.unit || ''}</td>
        </tr>
        ${partialNoteKelete}`;
      }
      // Liquor: 2-line format â€” name on line 1, indented qty + unit_price + gross on line 2.
      // v1.10.63 â€” unit_price and gross now prefixed with curSym so the
      // paper matches the POS till receipt.
      const partialNote = partial ? `<tr><td colspan="4" style="font-size:9px;color:#b45309;padding-left:6px">was ${origQty} ${item.unit || ''} â€” reversed ${rq}</td></tr>` : '';
      return `
      <tr><td colspan="4" style="font-weight:700;padding-top:4px;${item.reversed ? 'text-decoration:line-through;color:#999;' : ''}">${nameLabel}</td></tr>
      <tr style="${rowWeight}${item.reversed ? 'color:#999;' : ''}">
        <td></td>
        <td style="text-align:right;padding-left:8px;${partial ? 'font-weight:700' : ''}">${netQty} ${item.unit || ''}</td>
        <td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(unitPx)}</td>
        <td style="text-align:right;white-space:nowrap;${partial ? 'font-weight:700' : ''}">${curSym}${fmt2(netTotal)}</td>
      </tr>
      ${partialNote}`;
    }).join('');

    // v1.10.63 â€” Payment section labels now respect isLiquorStyle. Liquor
    // (Mansa/Lusaka) uses Cash / MoMo / Bank; Kelete (Kassumbalesa) keeps
    // USD ($) / FRA / K. Same field routing convention as CashBook:
    // cash_received=Cash, fra_received=MoMo, k_received=Bank on Liquor.
    const paymentSection = (() => {
      const u = parseFloat(order.cash_received || 0);
      const f = parseFloat(order.fra_received || 0);
      const k = parseFloat(order.k_received || 0);
      const hasSplit = u + f + k > 0.001;
      const amtRecv = parseFloat(order.amount_received || 0);
      if (!hasSplit) {
        return `<tr class="amt"><td>Amt Received:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(amtRecv)}</td></tr>`;
      }
      if (isLiquorStyle) {
        return `${u > 0 ? `<tr><td>Cash:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(u)}</td></tr>` : ''}
                ${f > 0 ? `<tr><td>MoMo:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(f)}</td></tr>` : ''}
                ${k > 0 ? `<tr><td>Bank:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(k)}</td></tr>` : ''}
                <tr class="amt"><td>Total Received:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(amtRecv)}</td></tr>`;
      }
      return `${u > 0 ? `<tr><td>USD ($):</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(u)}</td></tr>` : ''}
              ${f > 0 ? `<tr><td>FRA:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${fmt0(f)}</td></tr>` : ''}
              ${k > 0 ? `<tr><td>K:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${fmt0(k)}</td></tr>` : ''}
              <tr class="amt"><td>Total Received:</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(amtRecv)}</td></tr>`;
    })();

    const dt = new Date(order.created_at + 'Z');
    const dateTimeStr = `${dt.toLocaleDateString('en-GB')} ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    // Cashier name â€” orders may store it under a couple of legacy fields.
    // Whichever we get, fall back to "Staff" so we never print blank.
    const cashierName = order.served_by || order.cashier_name || order.created_by_name || 'Staff';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      /* v1.10.63 â€” @page margin cleared, padding moved to body to match
         POS.js render pattern. Same asymmetric left offset (extra 3mm)
         to survive the Epson TM-T88VII paper-feed offset. */
      /* 2026-08-30 â€” 72mm, NOT 80mm. 80mm is the width of the PAPER; the print
     head only covers 72mm. The driver says so itself: its paper setting
     reads "ZPrinter Paper(80(72) x 3276mm)" â€” 80mm roll, 72mm printable.
     Declaring 80mm made Chrome lay the receipt out 8mm wider than the
     printer can reach, and the driver simply dropped the overhang. Every
     line lost the same three or four characters off the right: Walk-i(n),
     ZM(W), INV0060001067/9(0), 77.3(7). It read as a table problem, but the
     header and totals were clipped too â€” the canvas was just too wide.
     Matching the canvas to the print head means nothing can fall off. */
  @page { size: 72mm auto; margin: 0; }
      html, body { height: auto; margin: 0; padding: 0; overflow-x: hidden; }
      * { box-sizing: border-box; }
      body {
        width: 72mm;
        max-width: 72mm;
        padding: 2mm;
        /* v1.10.62 â€” Liquor uses Arial Black so sans-serif survives
           thermal rasterisation; regular Arial-bold prints thin grey.
           Kelete stays on Courier for the dual-currency reprint. */
        font-family: ${isLiquorStyle ? "'Arial Black', 'Impact', Arial, Helvetica, sans-serif" : "'Courier New', monospace"};
        font-size: 11px;
        color: #000;
        font-weight: 700;
      }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      /* 2026-08-30 â€” see the tax-invoice templates: width:100% is only a
         suggestion under table-layout:auto, so an unbreakable value stretches
         the table past the paper and takes every right-aligned figure with it. */
      /* 2026-08-30 â€” tables stop at 86% of the body. The remaining 14% is
     deliberately never printed on.
     Four earlier attempts tried to make the content FIT inside 100% â€”
     narrower page, narrower columns, smaller font, wrapping cells. But 100%
     is where the loss happens: a right-aligned value sits on the print
     head's last dot, and that dot is unreliable. It is why even 77.37 came
     out as 77.3 while the centred lines beside it printed in full.
     The reference receipt this was compared against does the same thing â€”
     its item table visibly stops well short of the edge. Leaving slack means
     an overflow eats into the margin instead of falling off the paper, and
     the Total column â€” the number that matters most and was always last in
     the row â€” is no longer the one closest to the cut. */
  table { width: 86%; max-width: 86%; }
      table tr > td:last-child { overflow-wrap: anywhere; word-break: break-word; }
      td { padding: 1px 0; vertical-align: top; }
      .c { text-align: center; }
      .div { text-align: center; font-size: 10px; margin: 3px 0; overflow: hidden; white-space: nowrap; }
      .grand { font-size: 16px; font-weight: 800; }
      .amt { font-size: 13px; font-weight: 700; }
    </style></head><body>
    <div class="c" style="font-size:14px;font-weight:700;letter-spacing:1px;">${businessName}</div>
    ${businessAddress ? `<div class="c" style="font-size:11px;">${String(businessAddress).replace(/\n/g, '<br/>')}</div>` : ''}
    ${businessPhone ? `<div class="c" style="font-size:11px;">Tel: ${businessPhone}</div>` : ''}
    <div class="div">${div}</div>
    <div class="c" style="font-weight:700;font-size:12px;">${order.status === 'Reversed' ? '*** REVERSED ***' : (isReprint ? '*** COPY / DUPLICATE ***' : 'SALES RECEIPT')}</div>
    ${isReprint && order.status !== 'Reversed' ? '<div class="c" style="font-size:10px;">This is a reprint â€” not the original tax invoice</div>' : ''}
    <div class="div">${div}</div>
    <table>
      <tr><td>Receipt #:</td><td></td><td style="text-align:right">${fmtInvoiceNo(order.order_number)}</td></tr>
      <tr><td>Date &amp; Time:</td><td></td><td style="text-align:right">${dateTimeStr}</td></tr>
      <tr><td>Customer:</td><td></td><td style="text-align:right">${order.customer_name || 'Walk-in'}</td></tr>
      <tr><td>Served by:</td><td></td><td style="text-align:right">${cashierName}</td></tr>
    </table>
    <div class="div">${div}</div>
    <table>
      ${isLiquorStyle
        ? '' /* Liquor: no header row â€” matches ESC/POS. */
        : '<tr style="font-size:10px"><td style="font-weight:700;">ITEM</td><td style="text-align:right;font-weight:700;">QTY</td></tr>'}
      ${itemRows}
    </table>
    <div class="div">${'-'.repeat(42)}</div>
    <table>
      <tr><td>Subtotal</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(order.subtotal)}</td></tr>
      ${parseFloat(order.discount) > 0 ? `<tr><td>Discount</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">-${curSym}${fmt2(order.discount)}</td></tr>` : ''}
    </table>
    <div class="div">${div}</div>
    <table>
      <tr class="grand"><td>TOTAL</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(order.total_amount)}</td></tr>
    </table>
    <div class="div">${div}</div>
    <table>
      ${paymentSection}
      <tr class="amt"><td>${parseFloat(order.change_amount || 0) >= 0 ? '*** CHANGE ***' : '*** BAL DUE ***'}</td><td></td><td></td><td style="text-align:right;white-space:nowrap;">${curSym}${fmt2(Math.abs(parseFloat(order.change_amount || 0)))}</td></tr>
    </table>
    <div class="div">${div}</div>
    <div class="c" style="margin-top:4px">Thank you for your purchase!</div>
    <div class="c">Please come again.</div>
    ${hasAltUnit ? `<div class="c" style="margin-top:6px;font-size:10px;">** sold in alternate unit (not default)</div>` : ''}
    </body></html>`;

    return html;
  };

  // v1.13.116 â€” Print Report now delegates to handleExportPDF so the
  // "Print" button opens the browser print dialog with the SAME rich A4
  // Sales-by-Item layout the Export PDF button produces. Previous
  // implementation rendered a thermal 80mm receipt-style summary â€” no
  // longer used (thermal print was unusable on regular office printers
  // and diverged from the exported PDF, confusing ZRA auditors comparing
  // the printed vs saved report).
  const handlePrintReport = async () => {
    return handleExportPDF();
  };

  // â”€â”€ Export the By-Item view as an A4 PDF (mirrors GRN/SIV design) â”€â”€â”€â”€â”€â”€â”€â”€
  // Opens a print preview in a new tab â€” user clicks "Save as PDF" in the
  // browser dialog. Same look-and-feel as the GRN/SIV print pages so reports
  // across the system stay consistent.
  const handleExportPDF = async () => {
    const dateLabel = dateFrom === dateTo
      ? new Date(dateFrom).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : `${new Date(dateFrom).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} â€” ${new Date(dateTo).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    // Fetch the per-item breakdown on demand so the PDF works from any tab,
    // not just after the user has visited By Item. Fallback to cached state
    // if the network call fails.
    let items = [];
    try {
      const fromUTC = dateFrom ? toSqliteUTC(new Date(`${dateFrom}T00:00:00`)) : '';
      const toUTC   = dateTo   ? toSqliteUTC(new Date(`${dateTo}T23:59:59`)) : '';
      const res = await getOrderProductSummary(fromUTC, toUTC, userFilter);
      items = res.data || [];
    } catch (e) {
      items = itemSummary || [];
    }
    items = items.slice().sort((a, b) => parseFloat(b.total_revenue || 0) - parseFloat(a.total_revenue || 0));
    const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtQty = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.firstName, authUser?.lastName].filter(Boolean).join(' ') || 'â€”';

    const rows = items.map((it, idx) => {
      const qInDisp = displayInDefaultUnit(it.total_qty, it);
      const avgInDisp = displayPriceInDefaultUnit(it.avg_price, it);
      return `<tr style="background:${idx % 2 === 1 ? '#f5f5f5' : '#fff'};border-bottom:1px solid #ddd">
        <td style="padding:7px 10px;color:#000;font-size:10.5px">${idx + 1}</td>
        <td style="padding:7px 10px;font-weight:700;font-family:monospace">${fmtQty(qInDisp.qty)} ${avgInDisp.unit}</td>
        <td style="padding:7px 10px;font-weight:600">${it.product_name || 'â€”'}</td>
        <td style="padding:7px 10px;font-size:10.5px;color:#444">${it.category_name || 'â€”'}</td>
        <td style="padding:7px 10px;font-size:10.5px">${avgInDisp.unit}</td>
        <td style="padding:7px 10px;text-align:right;font-family:monospace">${curSym}${fmt(avgInDisp.price)} <span style="font-size:9px;color:#666">/ ${avgInDisp.unit}</span></td>
        <td style="padding:7px 10px;text-align:right;font-weight:700;font-family:monospace">${curSym}${fmt(it.total_revenue)}</td>
      </tr>`;
    }).join('');

    const grandRevenue = items.reduce((s, it) => s + parseFloat(it.total_revenue || 0), 0);

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales by Item â€” ${dateLabel}</title><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
      td{font-size:11px}
      tfoot td{padding:10px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${businessName}</div>
          <div style="font-size:10px;color:#000;line-height:1.7">${businessPhone || ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#000;margin-bottom:4px">Sales by Item</div>
          <div style="font-size:15px;font-weight:700">${dateLabel}</div>
          <div style="font-size:9px;color:#000;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        ${[
          ['Total Revenue', `${curSym}${fmt(totalRevenue)}`],
          ['Cash Sales', `${curSym}${fmt(totalCashSales)}`],
          ['Credit Sales', `${curSym}${fmt(totalCreditSales)}`],
          ['Discounts', `${curSym}${fmt(totalDiscount)}`],
        ].map(([lbl, val]) => `
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:14px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">
        <table>
          <thead><tr>
            <th style="width:28px">#</th>
            <th>Total Qty Sold</th>
            <th>Product</th>
            <th>Category</th>
            <th>Unit</th>
            <th style="text-align:right">Avg Unit Price</th>
            <th style="text-align:right">Total Revenue</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" style="padding:20px;text-align:center;color:#666">No sales in this period</td></tr>'}</tbody>
          <tfoot><tr>
            <td colspan="6">GRAND TOTAL â€” ${items.length} product${items.length !== 1 ? 's' : ''}</td>
            <td style="text-align:right;font-size:13px;font-family:monospace">${curSym}${fmt(grandRevenue)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;margin-bottom:16px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px;color:#000">${businessName} â€” Confidential</span>
        <span style="font-size:9px;color:#000">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => { w.print(); }, 300); }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('salesReport')}</h1>
          <p>{t('salesReportSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* v1.13.43 â€” universal Excel/CSV/PDF export (ZRA checklist #30).
              v1.13.116 â€” PDF hidden here; the richer Export PDF button
              below replaces it (avoids two competing PDF flows). */}
          {/* 2026-09-01 â€” by ITEM, not by transaction. Export PDF and Print
              Report have produced a Sales-by-Item layout since v1.13.116
              while these two still emitted the invoice list, so the same
              button row handed out two different reports. The user asked for
              one answer: what was sold. Sorted by revenue, same order as the
              PDF, so the three exports agree line for line. */}
          <ExportButtons
            rows={[...itemSummary].sort((a, b) =>
              parseFloat(b.total_revenue || 0) - parseFloat(a.total_revenue || 0))}
            filename={`sales-by-item_${dateFrom}${dateFrom !== dateTo ? '_to_' + dateTo : ''}`}
            sheetName="Sales by Item"
            showPdf={false}
            columns={[
              { key: 'product_name',  label: 'Product',   format: v => v || '-' },
              { key: 'category_name', label: 'Category',  format: v => v || '-' },
              // Quantity and price are converted to the product's default unit
              // so the sheet reads in Boxes where the screen says Boxes, rather
              // than in whatever base unit the sale happened to be stored in.
              { key: 'total_qty',     label: 'Qty Sold',  format: (_, r) => {
                  const d = displayInDefaultUnit(r.total_qty, r);
                  return Number(d.qty || 0).toFixed(2);
                } },
              { key: 'unit',          label: 'Unit',      format: (_, r) =>
                  displayPriceInDefaultUnit(r.avg_price, r).unit || r.unit || '' },
              { key: 'avg_price',     label: 'Avg Price', format: (_, r) =>
                  Number(displayPriceInDefaultUnit(r.avg_price, r).price || 0).toFixed(2) },
              { key: 'total_revenue', label: 'Revenue',   format: v => Number(v || 0).toFixed(2) },
            ]}
            pdfOptions={{
              title: 'Sales by Item',
              subtitle: dateFrom === dateTo ? dateFrom : `${dateFrom} â†’ ${dateTo}`,
              businessName,
            }}
          />
          {/* v1.13.92 â€” reverted v1.13.91 removal; both PDF exports live
              side-by-side again per user request. */}
          <button
            onClick={handleExportPDF}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
          >
            <FiFileText size={15} /> Export PDF
          </button>
          <button
            onClick={handleThermalReport}
            title="Print the by-item figures on the 80mm till roll"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
          >
            <FiPrinter size={15} /> Thermal
          </button>
          <button
            onClick={handlePrintReport}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
          >
            <FiPrinter size={15} /> {t('printReport')}
          </button>
        </div>
      </div>

      {/* Filters */}
      <style>{`
        .sr-date-box:focus-within {
          border-color: #2563eb !important;
          box-shadow: 0 0 0 3px rgba(37,99,235,0.12);
        }
        .sr-date-input::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.6; }
        .sr-clear-btn {
          display: inline-flex; align-items: center; gap: 7px;
          padding: 10px 20px;
          background: linear-gradient(135deg, #f87171, #dc2626);
          color: #fff; border: none; border-radius: 10px;
          cursor: pointer; font-size: 13px; font-weight: 700;
          box-shadow: 0 3px 10px rgba(220,38,38,0.25);
          transition: transform 0.15s, box-shadow 0.15s;
          white-space: nowrap; align-self: flex-end;
        }
        .sr-clear-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 16px rgba(220,38,38,0.4);
        }
        .sr-clear-btn:active { transform: scale(0.97); }
      `}</style>

      <div className="card" style={{ marginBottom: 24, padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <FiCalendar style={{ color: '#2563eb', fontSize: 16 }} />
          <span style={{ fontWeight: 700, fontSize: 14, color: '#1e3a5f' }}>{t('filterByDate')}</span>
          {(dateFrom || dateTo) && (
            <span style={{
              marginLeft: 6, padding: '2px 10px', borderRadius: 20,
              background: '#eff6ff', color: '#2563eb',
              fontSize: 11, fontWeight: 600, border: '1px solid #bfdbfe'
            }}>
              {dateFrom === dateTo && dateFrom
                ? dateFrom === today ? t('today') : dateFrom
                : `${dateFrom || '...'} â†’ ${dateTo || '...'}`}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {/* From Date */}
          <div style={{ flex: '0 0 auto' }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {t('from')}
            </label>
            <div className="sr-date-box" style={{
              display: 'flex', alignItems: 'center', gap: 8,
              border: '1.5px solid #e5e7eb', borderRadius: 10,
              padding: '9px 14px', background: '#f8faff',
              transition: 'border-color 0.15s, box-shadow 0.15s'
            }}>
              <FiCalendar style={{ color: '#2563eb', flexShrink: 0 }} />
              <input
                type="date" value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="sr-date-input"
                style={{ border: 'none', outline: 'none', fontSize: 14, background: 'transparent', fontWeight: 500, color: '#1e293b', cursor: 'pointer' }}
              />
            </div>
          </div>

          {/* Arrow separator */}
          <div style={{ paddingBottom: 10, color: '#9ca3af', fontSize: 18, fontWeight: 300, flexShrink: 0 }}>â†’</div>

          {/* To Date */}
          <div style={{ flex: '0 0 auto' }}>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {t('to')}
            </label>
            <div className="sr-date-box" style={{
              display: 'flex', alignItems: 'center', gap: 8,
              border: '1.5px solid #e5e7eb', borderRadius: 10,
              padding: '9px 14px', background: '#f8faff',
              transition: 'border-color 0.15s, box-shadow 0.15s'
            }}>
              <FiCalendar style={{ color: '#2563eb', flexShrink: 0 }} />
              <input
                type="date" value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="sr-date-input"
                style={{ border: 'none', outline: 'none', fontSize: 14, background: 'transparent', fontWeight: 500, color: '#1e293b', cursor: 'pointer' }}
              />
            </div>
          </div>

          {/* User Filter */}
          {users.length > 1 && (
            <div style={{ flex: '0 0 auto' }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {t('cashier')}
              </label>
              <select
                value={userFilter}
                onChange={e => setUserFilter(e.target.value)}
                style={{ padding: '9px 14px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: 14, background: '#f8faff', color: '#1e293b', fontWeight: 500 }}
              >
                <option value="all">{t('allCashiers')}</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Clear Filter button */}
          <button className="sr-clear-btn" onClick={() => { setDateFrom(today); setDateTo(today); setDeviceFilter('all'); setInvoiceInput(''); setInvoiceSearch(''); }}>
            <FiX size={14} /> {t('resetToToday')}
          </button>
        </div>

        {/* 2026-09-23 â€” search by either invoice number. Sits under the date
            row rather than in it: while a search is running the dates do not
            apply, and putting it alongside them would suggest they combine. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <div style={{ position: 'relative', flex: '1 1 300px', maxWidth: 420 }}>
            <FiSearch size={15} style={{ position: 'absolute', left: 11, top: 11, color: '#94a3b8' }} />
            <input
              value={invoiceInput}
              onChange={e => setInvoiceInput(e.target.value)}
              onKeyDown={e => {
                // Enter searches, Escape abandons. Anyone typing a number reaches
                // for Enter before they reach for the mouse.
                if (e.key === 'Enter') setInvoiceSearch(invoiceInput);
                if (e.key === 'Escape') { setInvoiceInput(''); setInvoiceSearch(''); }
              }}
              placeholder="Search by invoice number"
              style={{ width: '100%', padding: '9px 34px 9px 34px', border: '1px solid #d1d5db',
                       borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}
            />
            {invoiceInput && (
              <button onClick={() => { setInvoiceInput(''); setInvoiceSearch(''); }} title="Clear"
                style={{ position: 'absolute', right: 6, top: 6, background: 'none', border: 0,
                         cursor: 'pointer', color: '#94a3b8', padding: 4, lineHeight: 1 }}>
                <FiX size={15} />
              </button>
            )}
          </div>
          <button
            onClick={() => setInvoiceSearch(invoiceInput)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px',
                     background: '#C8102E', color: '#fff', border: 'none', borderRadius: 8,
                     cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiSearch size={14} /> Search
          </button>
          {invoiceQuery && (
            <span style={{ fontSize: 12.5, color: '#C8102E', background: '#fef2f2',
                           border: '1px solid #fecaca', borderRadius: 7, padding: '6px 11px' }}>
              {filtered.length === 0
                ? 'Nothing matches that number.'
                : `${filtered.length} match${filtered.length === 1 ? '' : 'es'} â€” all dates searched.`}
            </span>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 16,
        marginBottom: 24
      }}>
        {/* Total Revenue (accrual â€” all sales billed) */}
        <div style={{
          borderRadius: 14, padding: '20px 22px',
          background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(37,99,235,0.3)',
          display: 'flex', alignItems: 'center', gap: 16, position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <FiDollarSign size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('totalRevenue')}</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{curSym}{(parseFloat(totalRevenue)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            {/* v1.10.101 â€” over-collected label hidden on Liquor. The
                concept only applies where the cashier can *choose* to keep
                surplus in a specific currency drawer (Kassumbalesa tri-
                currency). On Liquor branches change always goes back to
                the customer physically; there's no "kept" amount. Historical
                pre-v1.10.81 orders may still carry classifier values in
                overpaid_kept_amt but they no longer represent till reality. */}
            {!isLiquorStyle && totalOverpaidAsUSD > 0.005 && (
              <div style={{ fontSize: 11, opacity: 0.9, marginTop: 3, color: '#fef3c7' }}>
                + Over-collected â‰ˆ {curSym}{totalOverpaidAsUSD.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                {' '}
                <span style={{ opacity: 0.8 }}>
                  ({totalOverpaidUSD > 0 ? `USD ${totalOverpaidUSD.toFixed(2)}` : ''}
                  {totalOverpaidFRA > 0 ? `${totalOverpaidUSD > 0 ? ' Â· ' : ''}FRA ${totalOverpaidFRA.toFixed(0)}` : ''}
                  {totalOverpaidK   > 0 ? `${(totalOverpaidUSD > 0 || totalOverpaidFRA > 0) ? ' Â· ' : ''}K ${totalOverpaidK.toFixed(0)}` : ''})
                </span>
              </div>
            )}
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{activeOrders.length} order(s){filtered.length > activeOrders.length ? ` Â· ${filtered.length - activeOrders.length} reversed` : ''}</div>
          </div>
        </div>

        {/* Cash Sales â€” v1.8.1 triple currency. Each row is net cash received
            in that currency (paid âˆ’ change given), in the currency's own
            units. Kelete is cash-only; no card / MoMo / bank to break out. */}
        <div style={{
          borderRadius: 14, padding: '16px 18px',
          background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(22,163,74,0.3)',
          position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{t('cashSales')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {/* v1.9.27 â€” Liquor branches break Cash Sales by method
                (Cash / MoMo / Bank); Kelete multi-currency branches break
                by currency (USD/FRA/K). The bottom â‰ˆ total line stays. */}
            {isLiquorStyle ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>Cash</span>
                  <span style={{ fontSize: 17, fontWeight: 800 }}>{curSym}{(parseFloat(totalCashReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                </div>
                {/* 2026-09-11 â€” a hidden method shows only if money sits on it. */}
                {(methodShown('momo') || (parseFloat(totalMomoReceived) || 0) > 0.004) && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>MoMo</span>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>{curSym}{(parseFloat(totalMomoReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                  </div>
                )}
                {(methodShown('bank') || (parseFloat(totalBankReceived) || 0) > 0.004) && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>Bank</span>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>{curSym}{(parseFloat(totalBankReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                {showUSD && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>USD</span>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>${(parseFloat(totalUsdReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                  </div>
                )}
                {showFRA && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>FRA</span>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>{(parseFloat(totalFraReceived)||0).toLocaleString(undefined,{maximumFractionDigits:0})}</span>
                  </div>
                )}
                {showK && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>K</span>
                    <span style={{ fontSize: 17, fontWeight: 800 }}>{(parseFloat(totalKReceived)||0).toLocaleString(undefined,{maximumFractionDigits:0})}</span>
                  </div>
                )}
              </>
            )}
          </div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 6, borderTop: '1px solid rgba(255,255,255,0.2)', paddingTop: 4 }}>
            â‰ˆ {curSym}{(parseFloat(totalCashSales)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} total
          </div>
        </div>

        {/* Credit Sales (unpaid portion that became receivable) */}
        <div style={{
          borderRadius: 14, padding: '20px 22px',
          background: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(217,119,6,0.3)',
          display: 'flex', alignItems: 'center', gap: 16, position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <FiFileText size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('creditSales')}</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{curSym}{(parseFloat(totalCreditSales)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{t('chargedToAccount')}</div>
          </div>
        </div>

        {/* Total Discounts (kept as 4th â€” useful context) */}
        <div style={{
          borderRadius: 14, padding: '20px 22px',
          background: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(220,38,38,0.3)',
          display: 'flex', alignItems: 'center', gap: 16, position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <FiDollarSign size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{t('totalDiscounts')}</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{curSym}{(parseFloat(totalDiscount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>{t('givenToCustomers')}</div>
          </div>
        </div>

        {/* v1.13.50 â€” Profit tile: revenue minus per-sale COGS (frozen at
            time of each sale via stock_movements.cost_at_sale).
            2026-09-01 â€” hidden with the rest of the margin figures. It was the
            most visible of them: a 24px number in a green tile at the top of a
            page every cashier opens. */}
        {SHOW_MARGIN_COLUMNS && <div style={{
          borderRadius: 14, padding: '20px 22px',
          background: 'linear-gradient(135deg, #059669 0%, #047857 100%)',
          color: '#fff', boxShadow: '0 4px 16px rgba(5,150,105,0.3)',
          display: 'flex', alignItems: 'center', gap: 16, position: 'relative', overflow: 'hidden'
        }}>
          <div style={{ position: 'absolute', right: -12, top: -12, width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <FiDollarSign size={22} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Profit</div>
            <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{curSym}{(parseFloat(totalProfit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>COGS {curSym}{(parseFloat(totalCogs)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          </div>
        </div>}

      </div>

      {/* v1.13.155 â€” possible duplicates. Sits above the tabs so it is seen
          before the day is closed, not found afterwards. Renders nothing at
          all when there is nothing to review. */}
      {dupes.length > 0 && (
        <div style={{
          border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 12,
          padding: '14px 16px', marginBottom: 18,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <FiAlertTriangle size={17} style={{ color: '#b45309', flex: 'none' }} />
            <strong style={{ color: '#92400e', fontSize: 14 }}>
              {dupes.length} possible duplicate{dupes.length > 1 ? 's' : ''} â€” review before closing the day
            </strong>
            <button onClick={() => setDupesOpen(o => !o)}
              style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: '1px solid #fcd34d', background: '#fff', color: '#92400e', cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>
              {dupesOpen ? 'Hide' : 'Show'}
            </button>
          </div>

          {dupesOpen && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {dupes.map(p => (
                <div key={p.pair_key} style={{
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  padding: '10px 12px', background: '#fff', border: '1px solid #fde68a', borderRadius: 9,
                }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 700, color: '#0f172a' }}>
                    {fmtInvoiceNo(p.a_number)} â†’ {fmtInvoiceNo(p.b_number)}
                  </span>
                  <span style={{ fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
                    {curSym}{(parseFloat(p.total) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  {p.first_item && (
                    <span style={{ fontSize: 12.5, color: '#6b7280' }}>{p.first_item}</span>
                  )}
                  {/* The gap is the whole point. Six seconds is a duplicate;
                      twenty-nine is two customers at opening time. No threshold
                      can tell those apart â€” a person reading this number can. */}
                  <span style={{
                    fontSize: 12.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                    color: p.secs_apart <= 15 ? '#b91c1c' : '#b45309',
                  }}>
                    {p.secs_apart} second{p.secs_apart === 1 ? '' : 's'} apart
                  </span>
                  <button
                    onClick={() => handleDismissDupe(p)}
                    disabled={dismissing === p.pair_key}
                    title="Both sales stay as they are. This only stops the warning."
                    style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: dismissing === p.pair_key ? 'wait' : 'pointer', fontSize: 12.5, fontWeight: 700 }}>
                    {dismissing === p.pair_key ? 'Savingâ€¦' : 'Reviewed â€” not duplicates'}
                  </button>
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: '#92400e', paddingLeft: 2 }}>
                To undo a sale use its <strong>Reverse</strong> button in the table below.
                â€œReviewedâ€ changes nothing â€” it only hides the warning.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'transactions', label: t('transactions') },
          { key: 'byItem', label: t('byItem') },
          { key: 'byPayment', label: t('byPayment') },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 22px', border: 'none', background: 'none',
              cursor: 'pointer', fontSize: 14, fontWeight: 700,
              color: activeTab === tab.key ? '#2563eb' : '#6b7280',
              borderBottom: activeTab === tab.key ? '3px solid #2563eb' : '3px solid transparent',
              marginBottom: -2, transition: 'color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Transactions Tab */}
      {activeTab === 'transactions' && (
      <div className="card">
        <div className="card-header">
          <h3>Sales Transactions</h3>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{filtered.length} records ({activeOrders.length} active)</span>
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>{t('loading')}</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>No sales records found.</div>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  {/* 2026-09-03 â€” Receipt Number and ZRA Receipt merged into
                      one column. The ZRA composite is what a customer quotes
                      off their paper receipt and what ZRA's portal knows, so
                      it leads; our order number sits under it. Also buys back
                      a column on a table that already scrolls sideways. */}
                  <th>Invoice No</th>
                  <th>{t('date')}</th>
                  <th>{t('subtotal')}</th>
                  <th>{t('discount')}</th>
                  <th>Total</th>
                  {SHOW_MARGIN_COLUMNS && <th>COGS</th>}
                  {SHOW_MARGIN_COLUMNS && <th>Profit</th>}
                  <th>Amount Received</th>
                  <th>Change</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.flatMap(order => {
                  // v1.13.50 â€” per-order COGS + profit. Backend attaches cogs
                  // via stock_movements.cost_at_sale; profit = total âˆ’ cogs.
                  // v1.13.155 â€” is this row half of a suspect pair?
                  const dupePair = dupeSyncIds.get(order.sync_id) || null;
                  const rowCogs   = parseFloat(order.cogs || 0);
                  const rowProfit = parseFloat(order.total_amount || 0) - rowCogs;
                  const sdcSuffix = String(order.zra_sdc_id || '').replace(/^SDC/i, '');
                  // v1.13.150 â€” Sale row's ZRA Receipt always uses the SALE's
                  // rcptNo (never the CN's) now that CNs get their own row
                  // below. Fixes the earlier "sequence looks skipped" bug
                  // where a Reversed row showed only CRN/N and hid the
                  // original INV/N-1.
                  // Build the SALE row (always emitted).
                  const saleRow = (
                    <tr key={`s-${order.id}`} style={{
                      opacity: order.status === 'Reversed' ? 0.6 : 1,
                      // v1.13.155 â€” an amber bar down the left edge joins the
                      // two halves of a suspect pair, so the eye catches them
                      // together rather than as two unrelated rows.
                      ...(dupePair ? { background: '#fffbeb', boxShadow: 'inset 3px 0 0 #f59e0b' } : {}),
                    }}>
                      <td>
                        <InvoiceNo order={order}>
                          {dupePair && (
                            <span
                              title={`Same items and total as ${fmtInvoiceNo(dupePair.a_sync_id === order.sync_id ? dupePair.b_number : dupePair.a_number)}, ${dupePair.secs_apart} seconds apart. Review before closing.`}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8, padding: '1px 7px', borderRadius: 5, background: '#fef3c7', color: '#92400e', fontSize: 10.5, fontWeight: 800, whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                              <FiAlertTriangle size={10} /> possible duplicate
                            </span>
                          )}
                        </InvoiceNo>
                      </td>
                      <td>{formatDate(order.created_at)}</td>
                      <td>{curSym}{(parseFloat(parseFloat(order.subtotal))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      <td style={{ color: parseFloat(order.discount) > 0 ? '#dc2626' : '#374151' }}>
                        {parseFloat(order.discount) > 0 ? `-${curSym}${(parseFloat(parseFloat(order.discount))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : `${curSym}0.00`}
                      </td>
                      <td><strong>{curSym}{(parseFloat(parseFloat(order.total_amount))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></td>
                      {SHOW_MARGIN_COLUMNS && <td style={{ color: '#b45309' }}>{curSym}{rowCogs.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>}
                      {SHOW_MARGIN_COLUMNS && <td style={{ color: rowProfit >= 0 ? '#059669' : '#dc2626', fontWeight: 600 }}>{curSym}{rowProfit.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>}
                      <td>{curSym}{(parseFloat(parseFloat(order.amount_received || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      <td style={{ color: '#16a34a' }}>{curSym}{(parseFloat(parseFloat(order.change_amount || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      <td>
                        <span className={`badge ${order.status === 'Reversed' ? 'badge-danger' : order.status === 'Partial' ? 'badge-warning' : 'badge-success'}`}>
                          {order.status}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => handleView(order.id)}
                            title="View Details"
                            style={{ padding: '5px 10px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                          >
                            <FiEye size={13} /> View
                          </button>
                          {/* POS small terminal only: print without opening View. */}
                          {isTerminal58() && (
                            <button
                              onClick={() => handleQuickPrint(order.id)}
                              title="Print receipt"
                              style={{ padding: '5px 10px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              <FiPrinter size={13} /> Print
                            </button>
                          )}
                          {hasPermission('SalesReport:Delete') && (
                            <button
                              onClick={() => handleReverse(order)}
                              disabled={order.status === 'Reversed'}
                              title="Reverse Order"
                              style={{ padding: '5px 10px', background: order.status === 'Reversed' ? '#e5e7eb' : '#dc2626', color: order.status === 'Reversed' ? '#9ca3af' : '#fff', border: 'none', borderRadius: 6, cursor: order.status === 'Reversed' ? 'not-allowed' : 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              <FiRotateCcw size={13} /> Reverse
                            </button>
                          )}
                          {/* v1.13.136 â€” Row-level CN button removed. See
                              older comment; Print CN now lives inside the
                              View modal only. */}
                        </div>
                      </td>
                    </tr>
                  );
                  // v1.13.151 â€” Emit a CN row for BOTH full-reversed AND
                  // partial-refunded orders. For full-reverse the CN
                  // amount = full total (every line refunded). For
                  // partial the CN amount = order_items reversed_quantity
                  // Ã— line price, aggregated server-side as
                  // partial_refund_amount on the /orders response
                  // (v1.13.151 backend). Also show CN row when the order
                  // has a local_cn_number (ZRA-off branches still stamp
                  // one), regardless of zra_cn_rcpt_no. This makes the
                  // Sales Report mirror ZRA's per-transaction listing
                  // for full-reverse, partial, and offline CNs alike.
                  const hasFullReverse = order.status === 'Reversed';
                  const hasPartial     = order.status === 'Partial' && parseFloat(order.partial_refund_amount || 0) > 0;
                  const hasAnyCn       = hasFullReverse || hasPartial;
                  if (hasAnyCn) {
                    const cnZraRcpt = order.zra_cn_rcpt_no
                      ? `CRN${sdcSuffix}/${order.zra_cn_rcpt_no}`
                      : 'â€”';
                    const cnKeleteRef = order.local_cn_number
                      || String(order.order_number || '').replace(/^INV-/, 'CN-').replace(/^ORD-/, 'CN-');
                    const cnDate = order.zra_cn_signed_at || order.partial_refund_at || order.created_at;
                    // Amount: full-reverse â†’ -total; partial â†’ -partial_refund_amount.
                    const cnAmountRaw = hasFullReverse
                      ? parseFloat(order.total_amount || 0)
                      : parseFloat(order.partial_refund_amount || 0);
                    const neg = (n) => -Math.abs(parseFloat(n) || 0);
                    const negSubtotal   = -Math.abs(cnAmountRaw);
                    const negDiscount   = 0;
                    const negTotal      = -Math.abs(cnAmountRaw);
                    // Rough proportional profit hit â€” full-reverse wipes
                    // full profit; partial wipes proportional slice. Best
                    // effort until backend attaches a real per-CN cogs.
                    const negProfit     = hasFullReverse
                      ? neg(rowProfit)
                      : -Math.abs(cnAmountRaw * (parseFloat(order.total_amount || 0) > 0 ? (rowProfit / parseFloat(order.total_amount)) : 0));
                    const negReceived   = -Math.abs(cnAmountRaw);
                    const cnRow = (
                      <tr key={`c-${order.id}`} style={{ background: '#fef2f2' }}>
                        {/* 2026-09-03 â€” same merge as the sale row above. The
                            CN keeps its OWN numbers (CRNâ€¦, CN-â€¦) and never
                            borrows the invoice's â€” v1.13.150. */}
                        <td>
                          <div style={{ lineHeight: 1.25 }}>
                            <div style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#b91c1c' }}>{cnZraRcpt}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{cnKeleteRef}</div>
                          </div>
                        </td>
                        <td>{formatDate(cnDate)}</td>
                        <td style={{ color: '#b91c1c' }}>âˆ’{curSym}{Math.abs(negSubtotal).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                        <td style={{ color: '#374151' }}>{negDiscount > 0 ? `-${curSym}${negDiscount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : `${curSym}0.00`}</td>
                        <td style={{ color: '#b91c1c' }}><strong>âˆ’{curSym}{Math.abs(negTotal).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></td>
                        {SHOW_MARGIN_COLUMNS && <td style={{ color: '#b45309' }}>{curSym}0.00</td>}
                        {SHOW_MARGIN_COLUMNS && <td style={{ color: '#b91c1c', fontWeight: 600 }}>âˆ’{curSym}{Math.abs(negProfit).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>}
                        <td style={{ color: '#b91c1c' }}>âˆ’{curSym}{Math.abs(negReceived).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                        <td style={{ color: '#9ca3af' }}>{curSym}0.00</td>
                        <td>
                          <span className="badge badge-danger" style={{ background: '#fee2e2', color: '#b91c1c', borderColor: '#fca5a5' }}>Credit Note</span>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              onClick={() => handleView(order.id, { asCn: true })}
                              title="View CN Details"
                              style={{ padding: '5px 10px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                              <FiEye size={13} /> View
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                    // CN row shows ABOVE its parent sale â€” CN is more
                    // recent chronologically and matches ZRA's newest-first
                    // portal ordering. flatMap concatenates as [cn, sale].
                    return [cnRow, saleRow];
                  }
                  return [saleRow];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {/* By Item Tab */}
      {activeTab === 'byItem' && (() => {
        const activeCatIds = selCatIds === null ? null : new Set(selCatIds.map(String));
        const filteredItems = itemSummary.filter(it => {
          if (activeCatIds === null) return true;
          if (!it.category_id) return false;
          return activeCatIds.has(String(it.category_id));
        });
        // Subtotals by main category
        const subMap = new Map();
        for (const it of filteredItems) {
          const main = allMains.find(m => String(m.id) === String(it.main_category_id));
          const key = main ? main.id : '__unassigned__';
          const name = main ? main.name : 'Uncategorized';
          const color = main ? main.color : '#6b7280';
          if (!subMap.has(key)) subMap.set(key, { name, color, qty: 0, revenue: 0 });
          const e = subMap.get(key);
          e.qty += parseFloat(it.total_qty || 0);
          e.revenue += parseFloat(it.total_revenue || 0);
        }
        const subs = Array.from(subMap.values()).sort((a, b) => b.revenue - a.revenue);

        return (
          <div className="card">
            <CategoryFilter
              categories={allCats}
              mainCategories={allMains}
              selectedMainIds={selMainIds}
              selectedCatIds={selCatIds}
              onChange={({ mainIds, catIds }) => { setSelMainIds(mainIds); setSelCatIds(catIds); }}
            />
            <div className="card-header">
              <h3>Sales by Item</h3>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{filteredItems.length} products</span>
            </div>
            {subs.length > 1 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 16px 16px' }}>
                {subs.map(s => (
                  <div key={s.name} style={{
                    padding: '6px 12px', borderRadius: 8,
                    background: (s.color || '#6b7280') + '15',
                    border: `1px solid ${(s.color || '#6b7280')}40`, fontSize: 12,
                  }}>
                    <span style={{ color: s.color, fontWeight: 700 }}>{s.name}:</span>
                    <span style={{ marginLeft: 6, color: '#374151', fontWeight: 600 }}>
                      qty {(parseFloat(s.qty)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} Â· {curSym}{(parseFloat(s.revenue)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {itemSummaryLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>{t('loading')}</div>
            ) : filteredItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>No items sold for the selected categories.</div>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Total Qty Sold</th>
                      <th>Product Name</th>
                      <th>Category</th>
                      <th>Unit</th>
                      <th>Avg Unit Price</th>
                      <th>Total Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((item, idx) => {
                      const disp = pickDisplayUnit(item);
                      const avgInDisp = displayPriceInDefaultUnit(item.avg_price, item);
                      return (
                      <tr key={idx} onClick={() => handleProductBreakdown(item.product_name)} style={{ cursor: 'pointer' }} title="Click to see individual sales">
                        <td style={{ color: '#9ca3af', fontSize: 12 }}>{idx + 1}</td>
                        <td><strong>{formatStockForProduct(item.total_qty, item)}</strong></td>
                        <td><strong style={{ color: '#2563eb' }}>{item.product_name}</strong></td>
                        <td style={{ color: '#6b7280', fontSize: 12 }}>{item.category_name || 'â€”'}</td>
                        <td style={{ color: '#6b7280' }}>
                          {disp.name || 'â€”'}
                          {disp.conv > 1 && (
                            <div style={{ fontSize: 10, color: '#9ca3af' }}>1 {disp.name} = {disp.conv} {item.unit}</div>
                          )}
                        </td>
                        <td>{curSym}{(parseFloat(avgInDisp.price)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} <span style={{ fontSize: 10, color: '#9ca3af' }}>/ {avgInDisp.unit}</span></td>
                        <td><strong style={{ color: '#16a34a' }}>{curSym}{(parseFloat(parseFloat(item.total_revenue))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f8faff', fontWeight: 700 }}>
                      <td colSpan={6} style={{ textAlign: 'right', paddingRight: 16, color: '#374151' }}>Grand Total</td>
                      <td style={{ color: '#16a34a' }}>K{(parseFloat(filteredItems.reduce((s, p) => s + parseFloat(p.total_revenue), 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* By Payment / Currency Tab â€” v1.8.1 */}
      {activeTab === 'byPayment' && isLiquorStyle && (() => {
        // v1.9.27 â€” Liquor-style branches: simple Cash / MoMo / Bank /
        // Credit breakdown. No currency split, no Given/Net/Â± because the
        // single-screen Pay modal collects whole amounts in each method.
        const fmtK = (n) => `${curSym}${(parseFloat(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
        const totalRevenue = activeOrders.reduce((s, o) => s + (parseFloat(o.total_amount)||0), 0);
        const pct = (n) => totalRevenue > 0 ? `${((n / totalRevenue) * 100).toFixed(1)}% of revenue` : '0% of revenue';
        // 2026-09-11 â€” a method the branch hides is left out, unless money
        // sits on it in this period.
        const showMomo = methodShown('momo') || (parseFloat(totalMomoReceived) || 0) > 0.004;
        const showBank = methodShown('bank') || (parseFloat(totalBankReceived) || 0) > 0.004;
        return (
          <div className="card">
            <div className="card-header">
              <h3>Sales by Payment Method</h3>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{activeOrders.length} order(s) Â· {fmtK(totalRevenue)}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${2 + (showMomo ? 1 : 0) + (showBank ? 1 : 0)}, 1fr)`, gap: 14, padding: '16px 20px' }}>
              {[
                { label: 'Cash',         value: totalCashReceived,   color: '#16a34a', show: true },
                { label: 'Mobile Money', value: totalMomoReceived,   color: '#ea580c', show: showMomo },
                { label: 'Bank',         value: totalBankReceived,   color: '#2563eb', show: showBank },
                { label: 'Credit',       value: totalCreditByMethod, color: '#dc2626', show: true },
              ].filter(b => b.show).map(b => (
                <div key={b.label} style={{ padding: '14px 16px', borderRadius: 12, background: b.color + '15', border: `1.5px solid ${b.color}40` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: b.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{b.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: b.color, marginTop: 4 }}>{fmtK(b.value)}</div>
                  <div style={{ fontSize: 11, color: b.color, opacity: 0.75, marginTop: 2 }}>{pct(b.value)}</div>
                </div>
              ))}
            </div>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '10px 12px', textAlign: 'left' }}>Date</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left' }}>Receipt #</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left' }}>Customer</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>Total</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>Cash</th>
                  {showMomo && <th style={{ padding: '10px 12px', textAlign: 'right', color: '#ea580c' }}>MoMo</th>}
                  {showBank && <th style={{ padding: '10px 12px', textAlign: 'right', color: '#2563eb' }}>Bank</th>}
                  <th style={{ padding: '10px 12px', textAlign: 'right', color: '#dc2626' }}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {activeOrders.map(o => {
                  // v1.9.29 â€” read cash_received / momo_received / bank_received
                  // (the actual POS save columns), not cash/momo/bank.
                  const cash = parseFloat(o.cash_received || 0);
                  const momo = parseFloat(o.momo_received || 0);
                  const bank = parseFloat(o.bank_received || 0);
                  const credit = Math.max(0, parseFloat(o.total_amount || 0) - parseFloat(o.amount_received || 0));
                  return (
                    <tr key={o.id}>
                      {/* v1.13.128k â€” was reading o.date which the /orders API doesn't
                          return; use o.created_at (UTC) to match every other tab. */}
                      <td style={{ padding: '8px 12px' }}>{o.created_at ? new Date(o.created_at + 'Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'â€”'}</td>
                      <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{fmtInvoiceNo(o.order_number)}</td>
                      <td style={{ padding: '8px 12px' }}>{o.customer_name || 'Walk-in'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>{fmtK(o.total_amount)}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: cash > 0 ? '#16a34a' : '#cbd5e1' }}>{cash > 0 ? fmtK(cash) : 'â€”'}</td>
                      {showMomo && <td style={{ padding: '8px 12px', textAlign: 'right', color: momo > 0 ? '#ea580c' : '#cbd5e1' }}>{momo > 0 ? fmtK(momo) : 'â€”'}</td>}
                      {showBank && <td style={{ padding: '8px 12px', textAlign: 'right', color: bank > 0 ? '#2563eb' : '#cbd5e1' }}>{bank > 0 ? fmtK(bank) : 'â€”'}</td>}
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: credit > 0 ? '#dc2626' : '#cbd5e1' }}>{credit > 0 ? fmtK(credit) : 'â€”'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f9fafb', fontWeight: 700, borderTop: '2px solid #e5e7eb' }}>
                  <td colSpan={3} style={{ padding: '10px 12px', textAlign: 'right' }}>TOTAL</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtK(totalRevenue)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>{fmtK(totalCashReceived)}</td>
                  {showMomo && <td style={{ padding: '10px 12px', textAlign: 'right', color: '#ea580c' }}>{fmtK(totalMomoReceived)}</td>}
                  {showBank && <td style={{ padding: '10px 12px', textAlign: 'right', color: '#2563eb' }}>{fmtK(totalBankReceived)}</td>}
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: '#dc2626' }}>{fmtK(totalCreditByMethod)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        );
      })()}

      {activeTab === 'byPayment' && !isLiquorStyle && (() => {
        // Kelete is cash-only across 3 currencies. Per-order breakdown shows
        // what the customer paid IN each currency (net of change in that same
        // currency) plus any unpaid balance (Credit, always in USD).
        // v1.8.76 â€” full per-currency breakdown for each order: Paid, Change Given,
        // Net (= Paid âˆ’ Given), and Â± (over-collection in that source currency).
        // Uses usd_change_given (physical USD returned) instead of change_amount
        // so over-payments kept in FRA/K don't bleed into the USD column.
        const adjusted = (o) => {
          const usdPaid  = parseFloat(o.cash_received || 0) || 0;
          const usdGiven = parseFloat(o.usd_change_given ?? o.change_amount ?? 0) || 0;
          const fraPaid  = parseFloat(o.fra_received || 0) || 0;
          const fraGiven = parseFloat(o.fra_change_given || 0) || 0;
          const kPaid    = parseFloat(o.k_received || 0) || 0;
          const kGiven   = parseFloat(o.k_change_given || 0) || 0;
          const keptCcy  = (o.overpaid_kept_ccy || '').toUpperCase();
          const keptAmt  = parseFloat(o.overpaid_kept_amt || 0) || 0;
          // v1.8.88 â€” absorbed shortage: walk-in customer paid less than
          // total_amount and cashier let them go (payment_method='Cash', within
          // tolerance). Source-currency attribution mirrors the backend
          // /cash-reports/daily endpoint (K â†’ FRA â†’ USD priority).
          let absorbedUSD = 0, absorbedFRA = 0, absorbedK = 0;
          if (o.payment_method === 'Cash') {
            const shortUSD = (parseFloat(o.total_amount) || 0) - (parseFloat(o.amount_received) || 0);
            if (shortUSD > 0.005) {
              const sellR  = parseFloat(o.selling_rate_used)   || 0;
              const sellRK = parseFloat(o.selling_rate_k_used) || 0;
              if (kPaid > 0 && sellRK > 0)        absorbedK   = shortUSD * sellRK;
              else if (fraPaid > 0 && sellR > 0)  absorbedFRA = shortUSD * sellR;
              else                                 absorbedUSD = shortUSD;
            }
          }
          return {
            usdPaid, usdGiven, usdNet: usdPaid - usdGiven,
            fraPaid, fraGiven, fraNet: fraPaid - fraGiven,
            kPaid,   kGiven,   kNet:   kPaid   - kGiven,
            // Â± Signed. Positive = kept in drawer (over). Negative = absorbed (short).
            // An order is either over or under, never both â€” so these are exclusive.
            usdDiff: (keptCcy === 'USD' ? keptAmt : 0) - absorbedUSD,
            fraDiff: (keptCcy === 'FRA' ? keptAmt : 0) - absorbedFRA,
            kDiff:   (keptCcy === 'K'   ? keptAmt : 0) - absorbedK,
            // v1.8.76 â€” only Credit / Partial-Credit rows contribute to credit.
            credit:  (o.payment_method === 'Credit' || o.payment_method === 'Partial-Credit')
              ? Math.max(0, parseFloat(o.total_amount || 0) - parseFloat(o.amount_received || 0))
              : 0,
          };
        };
        const totals = activeOrders.reduce((acc, o) => {
          const r = adjusted(o);
          return {
            usdPaid: acc.usdPaid + r.usdPaid, usdGiven: acc.usdGiven + r.usdGiven, usdNet: acc.usdNet + r.usdNet, usdDiff: acc.usdDiff + r.usdDiff,
            fraPaid: acc.fraPaid + r.fraPaid, fraGiven: acc.fraGiven + r.fraGiven, fraNet: acc.fraNet + r.fraNet, fraDiff: acc.fraDiff + r.fraDiff,
            kPaid:   acc.kPaid   + r.kPaid,   kGiven:   acc.kGiven   + r.kGiven,   kNet:   acc.kNet   + r.kNet,   kDiff:   acc.kDiff   + r.kDiff,
            credit:  acc.credit  + r.credit,
            // Legacy aliases for the summary cards that already exist below.
            usd: acc.usd + (r.usdNet), fra: acc.fra + r.fraNet, k: acc.k + r.kNet,
          };
        }, { usdPaid: 0, usdGiven: 0, usdNet: 0, usdDiff: 0, fraPaid: 0, fraGiven: 0, fraNet: 0, fraDiff: 0, kPaid: 0, kGiven: 0, kNet: 0, kDiff: 0, credit: 0, usd: 0, fra: 0, k: 0 });

        return (
          <div className="card">
            <div className="card-header">
              <h3>Sales by Currency</h3>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{activeOrders.length} order(s)</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, padding: '16px 20px' }}>
              {[
                { label: 'USD ($)', value: totals.usd,    color: '#16a34a', prefix: '$', dec: 2 },
                { label: 'FRA',     value: totals.fra,    color: '#7c3aed', prefix: '',  dec: 0, suffix: ' FRA' },
                { label: 'K',       value: totals.k,      color: '#ea580c', prefix: '',  dec: 0, suffix: ' K' },
                { label: 'Credit',  value: totals.credit, color: '#dc2626', prefix: '$', dec: 2 },
              ].map(b => (
                <div key={b.label} style={{ padding: '14px 16px', borderRadius: 12, background: b.color + '15', border: `1.5px solid ${b.color}40` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: b.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{b.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: b.color, marginTop: 4 }}>
                    {b.prefix}{(parseFloat(b.value)||0).toLocaleString(undefined,{minimumFractionDigits:b.dec,maximumFractionDigits:b.dec})}{b.suffix || ''}
                  </div>
                </div>
              ))}
            </div>

            {/* v1.8.76 â€” wide grouped table: per-currency Paid / Given / Net / Â±.
                Two header rows: top has merged ccy groups; bottom has sub-labels. */}
            <div style={{ overflow: 'auto' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, margin: '0 0 16px', minWidth: 1100 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'left',  fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Date</th>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'left',  fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Receipt #</th>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'left',  fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Customer</th>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Total ($)</th>
                  <th colSpan={4} style={{ padding: '8px 12px',  textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#16a34a', textTransform: 'uppercase', borderBottom: '1px solid #bbf7d0', background: '#f0fdf4' }}>USD ($)</th>
                  <th colSpan={4} style={{ padding: '8px 12px',  textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase', borderBottom: '1px solid #ddd6fe', background: '#faf5ff' }}>FRA</th>
                  <th colSpan={4} style={{ padding: '8px 12px',  textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#ea580c', textTransform: 'uppercase', borderBottom: '1px solid #fed7aa', background: '#fff7ed' }}>K</th>
                  <th rowSpan={2} style={{ padding: '10px 12px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', verticalAlign: 'middle' }}>Credit ($)</th>
                </tr>
                <tr style={{ background: '#f9fafb' }}>
                  {['Paid', 'Given', 'Net', 'Â±'].map((h, i) => (
                    <th key={`u${i}`} style={{ padding: '6px 8px', textAlign: 'right', fontSize: 10, fontWeight: 600, color: '#16a34a', borderBottom: '1px solid #e5e7eb', background: '#f0fdf4' }}>{h}</th>
                  ))}
                  {['Paid', 'Given', 'Net', 'Â±'].map((h, i) => (
                    <th key={`f${i}`} style={{ padding: '6px 8px', textAlign: 'right', fontSize: 10, fontWeight: 600, color: '#7c3aed', borderBottom: '1px solid #e5e7eb', background: '#faf5ff' }}>{h}</th>
                  ))}
                  {['Paid', 'Given', 'Net', 'Â±'].map((h, i) => (
                    <th key={`k${i}`} style={{ padding: '6px 8px', textAlign: 'right', fontSize: 10, fontWeight: 600, color: '#ea580c', borderBottom: '1px solid #e5e7eb', background: '#fff7ed' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeOrders.length === 0 ? (
                  <tr><td colSpan={17} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No sales for the selected period.</td></tr>
                ) : activeOrders.map(o => {
                  const r = adjusted(o);
                  const usdCol = '#16a34a', fraCol = '#7c3aed', kCol = '#ea580c';
                  const cell = (val, dec, sym, color) => {
                    const n = parseFloat(val) || 0;
                    if (Math.abs(n) < (dec === 0 ? 0.5 : 0.005)) return <span style={{ color: '#d1d5db' }}>â€”</span>;
                    return <span style={{ color }}>{sym}{n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}</span>;
                  };
                  // v1.8.88 â€” signed display. Positive (kept) keeps the passed
                  // amber color; negative (absorbed) overrides to red so loss
                  // is visually distinct from gain at a glance.
                  const diffCell = (val, dec, sym, color) => {
                    const n = parseFloat(val) || 0;
                    if (Math.abs(n) < (dec === 0 ? 0.5 : 0.005)) return <span style={{ color: '#d1d5db' }}>â€”</span>;
                    const isNeg = n < 0;
                    const c = isNeg ? '#dc2626' : color;
                    const sign = isNeg ? 'âˆ’' : '+';
                    return <span style={{ color: c, fontWeight: 700 }}>{sign}{sym}{Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}</span>;
                  };
                  return (
                    <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 12px' }}>{new Date(o.created_at + 'Z').toLocaleDateString('en-GB')}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 11 }}>{fmtInvoiceNo(o.order_number)}</td>
                      <td style={{ padding: '8px 12px' }}>{o.customer_name || 'Walk-in'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>{curSym}{(parseFloat(o.total_amount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      {/* USD group */}
                      <td style={{ padding: '8px', textAlign: 'right', background: '#f0fdf41a' }}>{cell(r.usdPaid,  2, '$', usdCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#f0fdf41a' }}>{cell(r.usdGiven, 2, '$', usdCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#f0fdf41a', fontWeight: 600 }}>{cell(r.usdNet, 2, '$', usdCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fffbeb' }}>{diffCell(r.usdDiff, 2, '$', '#92400e')}</td>
                      {/* FRA group */}
                      <td style={{ padding: '8px', textAlign: 'right', background: '#faf5ff1a' }}>{cell(r.fraPaid,  0, '', fraCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#faf5ff1a' }}>{cell(r.fraGiven, 0, '', fraCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#faf5ff1a', fontWeight: 600 }}>{cell(r.fraNet, 0, '', fraCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fffbeb' }}>{diffCell(r.fraDiff, 0, '', '#92400e')}</td>
                      {/* K group */}
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fff7ed1a' }}>{cell(r.kPaid,  0, '', kCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fff7ed1a' }}>{cell(r.kGiven, 0, '', kCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fff7ed1a', fontWeight: 600 }}>{cell(r.kNet, 0, '', kCol)}</td>
                      <td style={{ padding: '8px', textAlign: 'right', background: '#fffbeb' }}>{diffCell(r.kDiff, 0, '', '#92400e')}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: r.credit > 0 ? '#dc2626' : '#9ca3af', fontWeight: r.credit > 0 ? 700 : 400 }}>{r.credit > 0 ? `$${(parseFloat(r.credit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : 'â€”'}</td>
                    </tr>
                  );
                })}
              </tbody>
              {activeOrders.length > 0 && (
                <tfoot>
                  <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                    <td colSpan={3} style={{ padding: '11px 12px' }}>TOTAL</td>
                    <td style={{ padding: '11px 12px', textAlign: 'right' }}>{curSym}{(parseFloat(totalRevenue)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#16a34a' }}>${totals.usdPaid.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#16a34a' }}>${totals.usdGiven.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#16a34a' }}>${totals.usdNet.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    {/* v1.8.88 â€” signed totals: positive (kept) amber, negative (absorbed) red.
                        sumCell renders the aggregate with the correct sign and colour
                        and folds to 'â€”' when within rounding-dust tolerance. */}
                    {(() => null)()}
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: totals.usdDiff < -0.005 ? '#dc2626' : '#92400e', background: '#fffbeb' }}>
                      {Math.abs(totals.usdDiff) < 0.005
                        ? 'â€”'
                        : `${totals.usdDiff < 0 ? 'âˆ’' : '+'}$${Math.abs(totals.usdDiff).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`}
                    </td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#7c3aed' }}>{totals.fraPaid.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#7c3aed' }}>{totals.fraGiven.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#7c3aed' }}>{totals.fraNet.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: totals.fraDiff < -0.5 ? '#dc2626' : '#92400e', background: '#fffbeb' }}>
                      {Math.abs(totals.fraDiff) < 0.5
                        ? 'â€”'
                        : `${totals.fraDiff < 0 ? 'âˆ’' : '+'}${Math.abs(totals.fraDiff).toLocaleString(undefined,{maximumFractionDigits:0})}`}
                    </td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#ea580c' }}>{totals.kPaid.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#ea580c' }}>{totals.kGiven.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: '#ea580c' }}>{totals.kNet.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                    <td style={{ padding: '11px 8px', textAlign: 'right', color: totals.kDiff < -0.5 ? '#dc2626' : '#92400e', background: '#fffbeb' }}>
                      {Math.abs(totals.kDiff) < 0.5
                        ? 'â€”'
                        : `${totals.kDiff < 0 ? 'âˆ’' : '+'}${Math.abs(totals.kDiff).toLocaleString(undefined,{maximumFractionDigits:0})}`}
                    </td>
                    <td style={{ padding: '11px 12px', textAlign: 'right', color: '#dc2626' }}>{curSym}{(parseFloat(totals.credit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            </div>
          </div>
        );
      })()}

      {/* View Order Receipt Modal */}
      <style>{`
        @media print {
          .sr-no-print { display: none !important; }
          .sr-receipt-print { display: block !important; }
          body * { visibility: hidden; }
          #sr-receipt-content, #sr-receipt-content * { visibility: visible; }
          #sr-receipt-content { position: fixed; top: 0; left: 0; width: 100%; }
        }
        .sr-btn-close {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 20px; border: 1.5px solid #e5e7eb;
          border-radius: 10px; background: #fff; cursor: pointer;
          font-size: 13px; font-weight: 600; color: #374151;
          transition: background 0.15s, border-color 0.15s;
        }
        .sr-btn-close:hover { background: #f9fafb; border-color: #d1d5db; }
        .sr-btn-print {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 20px; border: none; border-radius: 10px;
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
          color: #fff; cursor: pointer; font-size: 13px; font-weight: 700;
          box-shadow: 0 3px 10px rgba(37,99,235,0.3);
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .sr-btn-print:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(37,99,235,0.4); }
        .sr-btn-reverse {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 20px; border: none; border-radius: 10px;
          background: linear-gradient(135deg, #f87171, #dc2626);
          color: #fff; cursor: pointer; font-size: 13px; font-weight: 700;
          box-shadow: 0 3px 10px rgba(220,38,38,0.3);
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .sr-btn-reverse:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(220,38,38,0.4); }
      `}</style>

      {/* 2026-09-13 â€” every pop-up on this page renders through <Portal>. The
          page's slide-in transform turns position:fixed into "fixed to the
          page", so on the POS terminal the receipt opened in the page flow
          with the report under it instead of over it. */}
      {(viewOrder || viewLoading) && (
        <Portal>
        <div className="sr-no-print" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          {/* 2026-09-10 â€” the receipt scrolls and the buttons below it stay put.
              The whole box used to scroll with the buttons at the very end, and
              at a fixed 420px it was wider than a handheld's screen: on the
              terminal the buttons were out of sight and out of reach. */}
          <div style={{ background: '#fff', borderRadius: 14, width: 'min(420px, 94vw)', maxHeight: '92vh', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column', flexWrap: 'nowrap' }}>
            {viewLoading ? (
              <div style={{ padding: 48, textAlign: 'center', color: '#6b7280' }}>Loading receipt...</div>
            ) : viewOrder && (
              <>
                {/* Receipt content */}
                <div id="sr-receipt-content" style={{ padding: '32px 28px', fontFamily: 'monospace', flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>

                  {/* Header */}
                  <div style={{ textAlign: 'center', marginBottom: 20 }}>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, fontFamily: 'sans-serif' }}>{businessName}</h2>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>Official Receipt</p>
                    {viewOrder.status === 'Reversed' && (
                      <div style={{ marginTop: 8, padding: '3px 12px', background: '#fee2e2', color: '#dc2626', borderRadius: 20, display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em' }}>
                        âœ• REVERSED
                      </div>
                    )}
                    {viewOrder.status === 'Partial' && (
                      <div style={{ marginTop: 8, padding: '3px 12px', background: '#fff7ed', color: '#d97706', borderRadius: 20, display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em' }}>
                        ~ PARTIAL REVERSAL
                      </div>
                    )}
                  </div>

                  <div style={{ borderTop: '1px dashed #d1d5db', margin: '12px 0' }} />

                  {/* Order Info */}
                  <div style={{ fontSize: 12, marginBottom: 12 }}>
                    {[
                      ['Invoice #', fmtInvoiceNo(viewOrder.order_number)],
                      ['Date',      new Date(viewOrder.created_at + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })],
                      ['Time',      new Date(viewOrder.created_at + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })],
                      ['Customer',  viewOrder.customer_name || 'Walk-in'],
                      ['Cashier',   viewOrder.created_by_name || (viewOrder.created_by ? (users.find(u => String(u.created_by) === String(viewOrder.created_by))?.full_name || `User #${viewOrder.created_by}`) : 'â€”')],
                      ['Payment',   (() => {
                        const c = parseFloat(viewOrder.cash_received || 0);
                        const m = parseFloat(viewOrder.momo_received || 0);
                        const b = parseFloat(viewOrder.bank_received || 0);
                        const methods = [c > 0 && 'Cash', m > 0 && 'MoMo', b > 0 && 'Bank'].filter(Boolean);
                        return methods.length > 0 ? methods.join(' + ') : (viewOrder.payment_method || 'Cash');
                      })()],
                    ].map(([label, value]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ color: '#6b7280' }}>{label}</span>
                        <strong>{value}</strong>
                      </div>
                    ))}
                  </div>

                  <div style={{ borderTop: '1px dashed #d1d5db', margin: '12px 0' }} />

                  {/* Items */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', fontSize: 11, color: '#6b7280', marginBottom: 6, fontWeight: 600 }}>
                      <span style={{ flex: 2 }}>ITEM</span>
                      <span style={{ textAlign: 'center', flex: 1 }}>QTY</span>
                      <span style={{ textAlign: 'right', flex: 1 }}>PRICE</span>
                      <span style={{ textAlign: 'right', flex: 1 }}>TOTAL</span>
                      <span className="sr-no-print" style={{ width: 28 }} />
                    </div>
                    {(viewOrder.items || []).map((item, idx) => {
                      // Show the NET line after any partial reversal:
                      //   netQty   = original quantity âˆ’ reversed_quantity
                      //   netTotal = unit_price Ã— netQty
                      // Fully-reversed lines (item.reversed = 1) keep the strike-through look.
                      const origQty = parseFloat(item.quantity || 0);
                      const rq      = parseFloat(item.reversed_quantity || 0);
                      const partial = !item.reversed && rq > 0;
                      const netQty  = partial ? Math.max(0, origQty - rq) : origQty;
                      const unitPx  = parseFloat(item.unit_price || 0);
                      // TOTAL column shows the PRE-line-discount value so the math
                      // (unit price Ã— qty) is honest. The line discount, if any,
                      // is rendered as a separate sub-row immediately below.
                      const netTotal = unitPx * netQty;
                      const lineDisc = parseFloat(item.discount || 0);
                      const lineDiscTotal = lineDisc * netQty;
                      // Flag sales in a unit other than the product's default sell unit.
                      // Skip products that only have one unit configured (nothing to compare).
                      const dispUnit = pickDisplayUnit(item);
                      const hasMultiUnits = (() => {
                        try {
                          const arr = item.units_json ? JSON.parse(item.units_json) : null;
                          if (Array.isArray(arr) && arr.length > 1) return true;
                        } catch { /* ignore */ }
                        return !!(item.alt_unit && item.alt_unit !== item.product_base_unit);
                      })();
                      const soldInNonDefault = hasMultiUnits && item.unit && dispUnit.name && item.unit !== dispUnit.name;
                      return (
                      <React.Fragment key={idx}>
                      <div style={{
                        display: 'flex', fontSize: 12, marginBottom: 5,
                        alignItems: 'center',
                        fontWeight: soldInNonDefault ? 700 : 'normal',
                        opacity: item.reversed ? 0.5 : 1
                      }}>
                        <span style={{ flex: 2, textDecoration: item.reversed ? 'line-through' : 'none' }}>
                          {item.product_name}
                          {/* ** flag when the line was sold in a non-default unit
                              (e.g. default is Box but cashier rang it up in pcs). */}
                          {soldInNonDefault && (
                            <span style={{ marginLeft: 4, color: '#dc2626', fontWeight: 700 }} title={`Sold in ${item.unit} â€” default is ${dispUnit.name}`}>**</span>
                          )}
                          {/* item.reversed is a SQLite int (0/1). Use !! so React
                              doesn't render literal "0" when not reversed. */}
                          {!!item.reversed && (
                            <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 700, color: '#dc2626', background: '#fee2e2', borderRadius: 4, padding: '1px 4px', verticalAlign: 'middle' }}>
                              VOID
                            </span>
                          )}
                          {partial && (
                            <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 700, color: '#b45309', background: '#fef3c7', borderRadius: 4, padding: '1px 4px', verticalAlign: 'middle' }}>
                              was {origQty} {item.unit || ''} â€” reversed {rq}
                            </span>
                          )}
                        </span>
                        <span style={{ textAlign: 'center', flex: 1, textDecoration: item.reversed ? 'line-through' : 'none', fontWeight: partial ? 700 : 400 }}>
                          {netQty}{item.unit ? ` ${item.unit}` : ''}
                        </span>
                        <span style={{ textAlign: 'right', flex: 1, textDecoration: item.reversed ? 'line-through' : 'none' }}>{curSym}{(parseFloat(unitPx)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        <span style={{ textAlign: 'right', flex: 1, textDecoration: item.reversed ? 'line-through' : 'none', fontWeight: partial ? 700 : 400 }}>{curSym}{(parseFloat(netTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        {/* Per-item void button â€” hidden on print, gated on
                            PARTIAL_REVERSE_ENABLED, and 2026-09-23 restricted to
                            Administrators. Voiding one line of a fiscalised sale
                            issues a credit note to ZRA; that is not a decision for
                            whoever happens to be on the till. It was visible to
                            every cashier. */}
                        <span className="sr-no-print" style={{ width: 28, display: 'flex', justifyContent: 'flex-end' }}>
                          {isAdmin && PARTIAL_REVERSE_ENABLED && !item.reversed && viewOrder.status !== 'Reversed' && (
                            <button
                              title="Void this item"
                              disabled={reversingItemId === item.id}
                              onClick={() => handleReverseItem(item)}
                              style={{
                                width: 22, height: 22, padding: 0, border: 'none',
                                borderRadius: 5, cursor: 'pointer',
                                background: reversingItemId === item.id ? '#e5e7eb' : 'linear-gradient(135deg,#f87171,#dc2626)',
                                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                flexShrink: 0
                              }}
                            >
                              <FiRotateCcw size={11} />
                            </button>
                          )}
                        </span>
                      </div>
                      {/* Per-line adjustment sub-row â€” shown when this line had a
                          discount OR surcharge applied. Same format as the thermal
                          print.
                          v1.10.106 â€” on Kassumbalesa (!isLiquorStyle), also print
                          the sub-row when discount < 0 (that's a per-unit price
                          markup via Change Price). Otherwise the receipt hides
                          the markup and the summary "Total surcharge" number has
                          no per-line detail to back it. Liquor branches keep
                          the old markdown-only behavior. */}
                      {((!isLiquorStyle && Math.abs(lineDisc) > 0.001) || lineDisc > 0) && (
                        <div key={`${idx}-disc`} style={{
                          display: 'flex', fontSize: 11,
                          color: lineDisc > 0 ? '#6b7280' : '#2563eb',
                          marginTop: -2, marginBottom: 6,
                          opacity: item.reversed ? 0.5 : 1,
                        }}>
                          <span style={{ flex: 2, paddingLeft: 16 }}>
                            {lineDisc > 0 ? 'discount' : 'surcharge'} {netQty}{item.unit ? ` ${item.unit}` : ''} Ã— {lineDisc > 0 ? '-' : '+'}{curSym}{Math.abs(parseFloat(lineDisc)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </span>
                          <span style={{ flex: 1 }} />
                          <span style={{ flex: 1 }} />
                          <span style={{ flex: 1, textAlign: 'right' }}>
                            {lineDiscTotal > 0 ? '-' : '+'}{curSym}{Math.abs(parseFloat(lineDiscTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </span>
                          <span className="sr-no-print" style={{ width: 28 }} />
                        </div>
                      )}
                      </React.Fragment>
                      );
                    })}
                  </div>

                  <div style={{ borderTop: '1px dashed #d1d5db', margin: '12px 0' }} />

                  {/* Totals â€” ORIGINAL transaction values + Partial Refunds section if any */}
                  {(() => {
                    const items = viewOrder.items || [];
                    // Pre-discount subtotal = sum of (unit_price Ã— original quantity).
                    // Using `quantity` (not netQty) so the totals reflect the ORIGINAL
                    // transaction; partial reverses are shown below as Refunds.
                    const originalSubtotal = items.reduce((s, it) =>
                      s + parseFloat(it.unit_price || 0) * parseFloat(it.quantity || 0), 0);
                    const lineDiscountSum = items.reduce((s, it) =>
                      s + parseFloat(it.discount || 0) * parseFloat(it.quantity || 0), 0);
                    const cartDiscount = parseFloat(viewOrder.discount || 0);
                    const originalDiscount = lineDiscountSum + cartDiscount;
                    const originalTotal = originalSubtotal - originalDiscount;
                    // Refunds: per-line refund = (reversed_quantity / quantity) Ã— total_price
                    const refundLines = items
                      .map(it => {
                        const rq = parseFloat(it.reversed_quantity || 0);
                        const q  = parseFloat(it.quantity || 0);
                        const lineTotal = parseFloat(it.total_price || 0);
                        if (!(rq > 0) || !(q > 0)) return null;
                        return { item: it, qty: rq, amount: (rq / q) * lineTotal };
                      })
                      .filter(Boolean);
                    const totalRefund = refundLines.reduce((s, r) => s + r.amount, 0);
                    const netTotal = originalTotal - totalRefund;
                    const amountReceived = parseFloat(viewOrder.amount_received || 0);
                    const originalChange = parseFloat(viewOrder.change_amount || 0);

                    return (
                      <div style={{ fontSize: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ color: '#6b7280' }}>Subtotal</span>
                          <span>{curSym}{(parseFloat(originalSubtotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>
                        {/* v1.8.57 â€” discount can be negative (= markup). Show
                            "Total discount" in red for + values, "Total surcharge"
                            in blue for âˆ’ values. */}
                        {Math.abs(originalDiscount) > 0.001 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: originalDiscount > 0 ? '#dc2626' : '#2563eb' }}>
                              {originalDiscount > 0 ? 'Total discount' : 'Total surcharge'}
                            </span>
                            <span style={{ color: originalDiscount > 0 ? '#dc2626' : '#2563eb' }}>
                              {originalDiscount > 0 ? '-' : '+'}{curSym}{Math.abs(originalDiscount).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                            </span>
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, paddingTop: 6, borderTop: '1px solid #e5e7eb', fontWeight: 700, fontSize: 14 }}>
                          <span>TOTAL</span>
                          <span>{curSym}{(parseFloat(originalTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>
                        {/* Split breakdown: show each method line that has a value */}
                        {(() => {
                          const cashIn = parseFloat(viewOrder.cash_received || 0);
                          const momoIn = parseFloat(viewOrder.momo_received || 0);
                          const bankIn = parseFloat(viewOrder.bank_received || 0);
                          const hasSplit = cashIn + momoIn + bankIn > 0.001;
                          if (!hasSplit) {
                            return (
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                <span style={{ color: '#6b7280' }}>Amount Received</span>
                                <span>{curSym}{(parseFloat(amountReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                              </div>
                            );
                          }
                          return (
                            <>
                              {cashIn > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#6b7280' }}>Cash</span>
                                  <span>{curSym}{(parseFloat(cashIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                </div>
                              )}
                              {momoIn > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#6b7280' }}>Mobile Money</span>
                                  <span>{curSym}{(parseFloat(momoIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                </div>
                              )}
                              {bankIn > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                  <span style={{ color: '#6b7280' }}>Bank</span>
                                  <span>{curSym}{(parseFloat(bankIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                </div>
                              )}
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontWeight: 700, borderTop: '1px dotted #e5e7eb', paddingTop: 3 }}>
                                <span>Total Received</span>
                                <span>{curSym}{(parseFloat(amountReceived)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                              </div>
                            </>
                          );
                        })()}
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, color: '#16a34a' }}>
                          <span>Change at Till</span>
                          <span>{curSym}{(parseFloat(originalChange)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>

                        {/* v1.8.51 â€” Credit / Partial-Credit sales: print the unpaid balance
                            so the customer's receipt shows what they still owe. */}
                        {(() => {
                          const total = parseFloat(viewOrder.total_amount || 0);
                          const recd  = parseFloat(amountReceived || 0);
                          const owed  = Math.max(0, total - recd);
                          if (owed <= 0.10) return null;
                          return (
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, color: '#b45309', borderTop: '1px solid #fde68a', marginTop: 6, paddingTop: 6, background: '#fef3c7', padding: '6px 10px', borderRadius: 4 }}>
                              <span>BALANCE ON CREDIT</span>
                              <span>{curSym}{owed.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                            </div>
                          );
                        })()}

                        {/* Partial Refunds section â€” only shown if any reversal occurred */}
                        {refundLines.length > 0 && (
                          <>
                            <div style={{ borderTop: '1px dashed #d1d5db', margin: '12px 0 8px' }} />
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#b45309', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                              Partial Refunds
                            </div>
                            {refundLines.map((r, idx) => (
                              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 11.5 }}>
                                <span style={{ color: '#374151' }}>
                                  {r.item.product_name} âˆ’{(parseFloat(Number(r.qty))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {r.item.unit || ''}
                                </span>
                                <span style={{ color: '#b45309' }}>âˆ’{curSym}{(parseFloat(r.amount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                              </div>
                            ))}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, paddingTop: 6, borderTop: '1px solid #fde68a', fontWeight: 700, color: '#b45309' }}>
                              <span>Refund Owed</span>
                              <span>{curSym}{(parseFloat(totalRefund)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTop: '2px solid #111827', fontWeight: 800, fontSize: 14 }}>
                              <span>NET TOTAL</span>
                              <span>{curSym}{(parseFloat(netTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}

                  <div style={{ borderTop: '1px dashed #d1d5db', margin: '16px 0 12px' }} />

                  <div style={{ textAlign: 'center', fontSize: 11, color: '#6b7280' }}>
                    <p style={{ margin: 0 }}>Thank you for your purchase!</p>
                    <p style={{ margin: '2px 0 0' }}>Please come again.</p>
                  </div>

                  {/* v1.13.151 â€” CN reference block. Shown when a credit
                      note (full reverse OR partial refund) exists for
                      this order â€” regardless of whether ZRA is enabled.
                      Local-only CNs at ZRA-off branches (e.g. Buseko)
                      still get local_cn_number stamped and display their
                      reference here, just without a ZRA rcptNo row. */}
                  {(viewOrder.zra_cn_rcpt_no || viewOrder.local_cn_number) && (() => {
                    const CN_REASON_LABEL_MAP = {
                      '01': 'Wrong product(s)',
                      '02': 'Wrong price',
                      '03': 'Damaged Goods',
                      '04': 'Wrong Customer invoiced',
                      '05': 'Duplicated invoice',
                      '06': 'Excess supplies',
                      '07': 'Other',
                    };
                    const rsnCd = viewOrder.zra_cn_rfd_rsn_cd || '';
                    const rsnLbl = CN_REASON_LABEL_MAP[rsnCd] || (viewOrder.zra_cn_rfd_rsn_other || 'â€”');
                    // CN Kelete ref: swap INV-/ORD- prefix for CN- if we
                    // don't have a stored local_cn_number.
                    const cnKeleteRef = viewOrder.local_cn_number
                      || String(viewOrder.order_number || '').replace(/^INV-/, 'CN-').replace(/^ORD-/, 'CN-');
                    const sdcSuffix = String(viewOrder.zra_sdc_id || viewOrder.zra_cn_sdc_id || '').replace(/^SDC/i, '');
                    const zraCnRef = viewOrder.zra_cn_rcpt_no
                      ? `CRN${sdcSuffix}/${viewOrder.zra_cn_rcpt_no}`
                      : null;
                    return (
                      <>
                        <div style={{ borderTop: '1px dashed #fca5a5', margin: '14px 0 10px' }} />
                        <div style={{ fontSize: 11, color: '#b91c1c', fontFamily: 'monospace', display: 'grid', gap: 4 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                            <span>CN No:</span>
                            <strong>{cnKeleteRef}</strong>
                          </div>
                          {zraCnRef && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                              <span>ZRA CN Receipt:</span>
                              <strong>{zraCnRef}</strong>
                            </div>
                          )}
                          {rsnCd && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                              <span>CN Reason:</span>
                              <strong>{rsnCd} â€” {rsnLbl}</strong>
                            </div>
                          )}
                        </div>
                        <div style={{ borderBottom: '1px dashed #fca5a5', margin: '10px 0 0' }} />
                      </>
                    );
                  })()}
                </div>

                {/* Action Buttons */}
                <div className="sr-no-print" style={{
                  display: 'flex', gap: 8, padding: '14px 24px 20px',
                  borderTop: '1px solid #f3f4f6', justifyContent: 'flex-end',
                  flexWrap: 'wrap', flexShrink: 0, background: '#fff'
                }}>
                  <button className="sr-btn-close" onClick={() => setViewOrder(null)}>
                    <FiX size={14} /> Close
                  </button>
                  {/* v1.13.152 â€” When View was clicked from a CN row,
                      hide the Print Receipt button â€” the cashier
                      opened the modal to inspect/print the CREDIT NOTE,
                      not the underlying sale receipt. Same rule below
                      hides Reverse Order in the CN-view path. */}
                  {!viewedAsCn && (
                    <button className="sr-btn-print" onClick={() => handlePrintReceipt(viewOrder)}>
                      <FiPrinter size={14} /> Print Receipt
                    </button>
                  )}
                  {/* v1.13.100 â€” Print Tax Credit Note (T08A #13). Only
                      shown when the reversal has a signed CN response.
                      v1.13.136 â€” Also shown when the backend stamped a local
                      CN number for a non-fiscal reversal (Buseko / ZRA off). */}
                  {viewOrder.zra_cn_signed_at && (viewOrder.zra_cn_rcpt_no || viewOrder.local_cn_number) && (
                    <button
                      className="sr-btn-print"
                      style={{ background: 'linear-gradient(135deg,#7c3aed,#6d28d9)' }}
                      onClick={() => handlePrintCreditNote(viewOrder)}
                    >
                      <FiPrinter size={14} /> Print Credit Note
                    </button>
                  )}
                  {/* v1.13.94 â€” Retry ZRA fiscalisation for a stuck order.
                      Visible only when zra_status is FAILED (sale committed
                      locally but VSDC hadn't accepted it). Same call the
                      60s background queue uses, just forced immediately. */}
                  {viewOrder.zra_status === 'FAILED' && (
                    <button
                      className="sr-btn-print"
                      style={{ background: 'linear-gradient(135deg,#f59e0b,#d97706)' }}
                      onClick={async () => {
                        try {
                          const res = await retryOrderZra(viewOrder.id);
                          if (res.data?.ok) {
                            alert('ZRA fiscalisation succeeded. Reload to see the QR + signature.');
                            const fresh = await getOrder(viewOrder.id);
                            setViewOrder(fresh.data);
                          } else {
                            alert(`Retry failed: ${res.data?.zra?.error || 'unknown'}. Background queue will keep trying.`);
                          }
                        } catch (err) {
                          alert(`Retry failed: ${err?.response?.data?.error || err.message}`);
                        }
                      }}
                      title="Force an immediate ZRA saveSales retry for this order"
                    >
                      <FiRefreshCw size={14} /> Retry ZRA
                    </button>
                  )}
                  {/* Explicit PDF button â€” visible only on phones AND only
                      when Mobile Print Mode is set to PDF Download.
                      Bypasses the backend ESC/POS chain entirely so the
                      flow is debuggable and predictable. */}
                  {shouldShowMobilePdfButton() && (
                    <button
                      className="sr-btn-print"
                      onClick={() => handleDownloadPdfReceipt(viewOrder)}
                      style={{ background: 'linear-gradient(135deg,#16a34a,#15803d)' }}
                    >
                      <FiDownload size={14} /> Download PDF
                    </button>
                  )}
                  {!viewedAsCn && viewOrder.status !== 'Reversed' && hasPermission('SalesReport:Delete') && (
                    <button className="sr-btn-reverse" onClick={() => { setViewOrder(null); handleReverse(viewOrder); }}>
                      <FiRotateCcw size={14} /> Reverse Order
                    </button>
                  )}
                  {/* v1.13.101 â€” Debit Note UI hidden for ZRA UAT
                      (2026-07-29). DN is optional per ZRA T08A #15
                      ("if the debit note feature has been implemented")
                      and Red Sea's business model doesn't use it. The
                      backend endpoints + fiscal wiring stay intact â€”
                      flip the `false && ...` guards to restore. */}
                  {false && viewOrder.status !== 'Reversed' && (
                    <button
                      className="sr-btn-print"
                      onClick={() => openDebitNoteModal(viewOrder)}
                      style={{ background: 'linear-gradient(135deg,#b45309,#92400e)' }}
                      title="Issue a Debit Note (additional charge on this invoice)">
                      + Debit Note
                    </button>
                  )}
                  {false && Array.isArray(viewOrder.__debitNotes) && viewOrder.__debitNotes.length > 0 && (
                    <button
                      className="sr-btn-print"
                      onClick={() => handlePrintDebitNote(viewOrder, viewOrder.__debitNotes[0])}
                      style={{ background: 'linear-gradient(135deg,#b45309,#78350f)' }}
                      title="Print the latest Debit Note on this invoice">
                      <FiPrinter size={14} /> Print DN{viewOrder.__debitNotes.length > 1 ? ` (${viewOrder.__debitNotes.length})` : ''}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        </Portal>
      )}

      {/* Partial Reverse Modal */}
      {reverseModal && (
        <Portal>
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 420, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Reverse line item</h3>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>{reverseModal.item.product_name}</p>
            </div>
            <div style={{ padding: '20px 24px' }}>
              {(() => {
                const it = reverseModal.item;
                const orig = parseFloat(it.quantity);
                const already = parseFloat(it.reversed_quantity || 0);
                const remainingInLineUnit = orig - already;
                const conv = parseFloat(it.conversion_factor || 1);
                const isLineAlt = !!(it.alt_unit && it.unit === it.alt_unit);
                const baseUnit = it.product_base_unit || (isLineAlt ? '' : it.unit);
                const remainingBase = isLineAlt ? remainingInLineUnit * conv : remainingInLineUnit;
                const isReverseAlt = !!(it.alt_unit && reverseModal.unit === it.alt_unit);
                const remainingInReverseUnit = isReverseAlt ? remainingBase / conv : remainingBase;

                return (
                  <>
                    <div style={{ fontSize: 13, color: '#374151', marginBottom: 12, lineHeight: 1.7, background: '#f9fafb', borderRadius: 8, padding: '10px 12px' }}>
                      <div>Original sold: <strong>{orig} {it.unit || ''}</strong>
                        {it.alt_unit && !isLineAlt && (<span style={{ color: '#9ca3af' }}> </span>)}
                      </div>
                      {already > 0 && <div>Already reversed: <strong style={{ color: '#dc2626' }}>{already} {it.unit || ''}</strong></div>}
                      <div>Remaining: <strong style={{ color: '#16a34a' }}>{remainingInLineUnit} {it.unit || ''}</strong>
                        {it.alt_unit && (
                          <span style={{ color: '#6b7280', fontSize: 12 }}> ({remainingBase} {baseUnit})</span>
                        )}
                      </div>
                    </div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>How much to reverse?</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="number"
                        autoFocus
                        min="0.01"
                        step="0.01"
                        max={remainingInReverseUnit}
                        value={reverseModal.qtyToReverse}
                        onChange={e => setReverseModal({ ...reverseModal, qtyToReverse: e.target.value })}
                        style={{ flex: 1, padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 16, outline: 'none', boxSizing: 'border-box' }}
                      />
                      {it.alt_unit ? (
                        <select
                          value={reverseModal.unit}
                          onChange={e => setReverseModal({ ...reverseModal, unit: e.target.value })}
                          style={{ padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff', minWidth: 130 }}
                        >
                          <option value={it.product_base_unit || baseUnit}>{it.product_base_unit || baseUnit}</option>
                          <option value={it.alt_unit}>{it.alt_unit} (1={conv})</option>
                        </select>
                      ) : (
                        <div style={{ padding: '10px 14px', color: '#6b7280', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#f9fafb', minWidth: 90, textAlign: 'center' }}>{it.unit || ''}</div>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
                      Pre-filled to full remaining. You can change qty or switch unit (e.g. customer returns 2 pcs when they bought boxes).
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                      Max in {reverseModal.unit}: <strong>{(parseFloat(remainingInReverseUnit)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>
                    </div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', margin: '14px 0 6px' }}>
                      Reason for reversal <span style={{ color: '#dc2626' }}>*</span>
                    </label>
                    <select
                      value={reverseModal.reason_cd}
                      onChange={e => setReverseModal(m => ({ ...m, reason_cd: e.target.value, error: null }))}
                      style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, background: '#fff' }}
                    >
                      <option value="01">01 â€” Wrong product(s)</option>
                      <option value="02">02 â€” Wrong price</option>
                      <option value="03">03 â€” Damaged goods</option>
                      <option value="04">04 â€” Wrong customer invoiced</option>
                      <option value="05">05 â€” Duplicated invoice</option>
                      <option value="06">06 â€” Excess supplies</option>
                      <option value="07">07 â€” Other (brief text required)</option>
                    </select>
                    {reverseModal.reason_cd === '07' && (
                      <div style={{ marginTop: 10 }}>
                        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                          Brief description <span style={{ color: '#dc2626' }}>*</span>
                        </label>
                        <input
                          type="text"
                          value={reverseModal.reason_other}
                          onChange={e => setReverseModal(m => ({ ...m, reason_other: e.target.value, error: null }))}
                          placeholder="e.g. customer changed mind"
                          maxLength={120}
                          style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 }}
                        />
                      </div>
                    )}
                    {reverseModal.error && (
                      <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', color: '#991b1b', borderRadius: 6, fontSize: 12 }}>
                        {reverseModal.error}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            <div style={{ padding: '14px 24px 20px', display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #f3f4f6' }}>
              <button onClick={() => setReverseModal(null)} className="sr-btn-close">Cancel</button>
              <button onClick={confirmReverseItem} className="sr-btn-reverse" disabled={reversingItemId === reverseModal.item.id}>
                <FiRotateCcw size={14} /> {reversingItemId === reverseModal.item.id ? 'Reversingâ€¦' : 'Reverse'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Product Breakdown Modal */}
      {breakdown && (
        <Portal>
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 640, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>{breakdown.productName}</h3>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: '#6b7280' }}>
                  Individual sales Â· {dateFrom === dateTo ? dateFrom : `${dateFrom} â†’ ${dateTo}`}
                </p>
              </div>
              <button onClick={() => setBreakdown(null)} style={{ padding: '6px 14px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#374151' }}>Close</button>
            </div>
            {/* Body */}
            <div style={{ padding: '16px 24px' }}>
              {breakdownLoading ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>{t('loading')}</div>
              ) : breakdown.items.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>No sales found for this period.</div>
              ) : (
                <>
                  <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f8faff' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>#</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Date & Time</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Order #</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Qty</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Unit Price</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.items.map((row, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 12px', color: '#9ca3af' }}>{i + 1}</td>
                          <td style={{ padding: '8px 12px', color: '#374151' }}>{new Date(row.created_at + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                          <td style={{ padding: '8px 12px', fontWeight: 600, color: '#2563eb' }}>{fmtInvoiceNo(row.order_number)}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right' }}>{(parseFloat(parseFloat(row.quantity))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right' }}>{curSym}{(parseFloat(parseFloat(row.unit_price))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#16a34a' }}>{curSym}{(parseFloat(parseFloat(row.total_price))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#f8faff', fontWeight: 700 }}>
                        <td colSpan={3} style={{ padding: '10px 12px', textAlign: 'right', color: '#374151' }}>Total</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>{(parseFloat(breakdown.items.reduce((s, r) => s + parseFloat(r.quantity), 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                        <td></td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', color: '#16a34a' }}>{curSym}{(parseFloat(breakdown.items.reduce((s, r) => s + parseFloat(r.total_price), 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* v1.13.136 â€” Reverse reason picker modal (ZRA UAT Â§3.8(b) â€” the CN
          must reflect a reason for the reversal). Dropdown of the 7 codes
          from VSDC spec Â§6.15. Default is '01 Wrong product'. Cancel aborts.
          On Continue, opens the AdminPasswordPrompt (pendingDelete) â€” the
          actual reversal only fires once admin password is entered. */}
      {reverseReasonModal && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 480, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>Reverse Sale</h3>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: '#6b7280' }}>
                {fmtInvoiceNo(reverseReasonModal.order.order_number)} â€” pick a reason, then confirm with admin password.
              </p>
            </div>
            <div style={{ padding: '18px 22px' }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                Reason for reversal <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <select
                value={reverseReasonModal.reason_cd}
                onChange={e => setReverseReasonModal(m => ({ ...m, reason_cd: e.target.value, error: null }))}
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, background: '#fff' }}
              >
                <option value="01">01 â€” Wrong product(s)</option>
                <option value="02">02 â€” Wrong price</option>
                <option value="03">03 â€” Damaged goods</option>
                <option value="04">04 â€” Wrong customer invoiced</option>
                <option value="05">05 â€” Duplicated invoice</option>
                <option value="06">06 â€” Excess supplies</option>
                <option value="07">07 â€” Other (brief text required)</option>
              </select>
              {reverseReasonModal.reason_cd === '07' && (
                <div style={{ marginTop: 12 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                    Brief description <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={reverseReasonModal.reason_other}
                    onChange={e => setReverseReasonModal(m => ({ ...m, reason_other: e.target.value, error: null }))}
                    placeholder="e.g. customer changed mind"
                    maxLength={120}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 }}
                  />
                </div>
              )}
              {reverseReasonModal.error && (
                <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', color: '#991b1b', borderRadius: 6, fontSize: 12 }}>
                  {reverseReasonModal.error}
                </div>
              )}
            </div>
            <div style={{ padding: '14px 22px 18px', display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid #e5e7eb' }}>
              <button
                onClick={() => setReverseReasonModal(null)}
                style={{ padding: '8px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
              >
                Cancel
              </button>
              <button
                onClick={proceedToAdminPasswordAfterReason}
                style={{ padding: '8px 16px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* v1.13.38 â€” Debit Note modal (ZRA checklist #21) */}
      {debitNoteModal && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 480, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>Debit Note</h3>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: '#6b7280' }}>
                Additional charge on invoice <strong>{fmtInvoiceNo(debitNoteModal.order.order_number)}</strong>
                {debitNoteModal.order.customer_name ? ` Â· ${debitNoteModal.order.customer_name}` : ''}
              </p>
            </div>
            <div style={{ padding: '18px 22px' }}>
              {debitNoteModal.success ? (
                <div style={{ padding: '14px 16px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, fontSize: 13, color: '#166534' }}>
                  {debitNoteModal.success}
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: 14 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Amount ({curSym})</label>
                    <input
                      type="number" min="0" step="0.01"
                      autoFocus
                      value={debitNoteModal.amount}
                      onChange={e => setDebitNoteModal(m => ({ ...m, amount: e.target.value }))}
                      placeholder="e.g. 150.00"
                      style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 15, boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Reason (ZRA)</label>
                    <select
                      value={debitNoteModal.reason_cd}
                      onChange={e => setDebitNoteModal(m => ({ ...m, reason_cd: e.target.value }))}
                      style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', background: '#fff' }}>
                      <option value="01">01 â€” Wrong product</option>
                      <option value="02">02 â€” Wrong price</option>
                      <option value="03">03 â€” Damaged</option>
                      <option value="04">04 â€” Wrong customer</option>
                      <option value="05">05 â€” Duplicate</option>
                      <option value="06">06 â€” Excess</option>
                      <option value="07">07 â€” Other</option>
                    </select>
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Notes (optional)</label>
                    <textarea
                      value={debitNoteModal.notes}
                      onChange={e => setDebitNoteModal(m => ({ ...m, notes: e.target.value }))}
                      placeholder="e.g. Delivery fee not billed at sale"
                      rows={2}
                      style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
                    />
                  </div>
                  {debitNoteModal.error && (
                    <div style={{ padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#b91c1c', marginBottom: 12 }}>
                      {debitNoteModal.error}
                    </div>
                  )}
                </>
              )}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setDebitNoteModal(null)}
                style={{ padding: '9px 16px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#374151' }}>
                {debitNoteModal.success ? 'Close' : 'Cancel'}
              </button>
              {!debitNoteModal.success && (
                <button
                  onClick={submitDebitNote}
                  disabled={debitNoteModal.saving}
                  style={{ padding: '9px 20px', border: 'none', borderRadius: 8, background: debitNoteModal.saving ? '#d97706' : '#b45309', color: '#fff', cursor: debitNoteModal.saving ? 'wait' : 'pointer', fontSize: 13, fontWeight: 700 }}>
                  {debitNoteModal.saving ? 'Issuingâ€¦' : 'Issue Debit Note'}
                </button>
              )}
              {/* v1.13.100 â€” Print the freshly-issued Tax Debit Note (T08A #14). */}
              {debitNoteModal.success && debitNoteModal.createdDn && (
                <button
                  onClick={() => handlePrintDebitNote(debitNoteModal.order, debitNoteModal.createdDn)}
                  style={{ padding: '9px 20px', border: 'none', borderRadius: 8, background: '#b45309', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                  Print Debit Note
                </button>
              )}
            </div>
          </div>
        </div>
        </Portal>
      )}

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

export default SalesReport;
