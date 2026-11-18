/**
 * noteSources.js — the one place that knows what each document calls its note.
 *
 * 2026-09-18. The same box is `notes` on a GRN, `description` on a Payment
 * Voucher, `comment` on a Cash Report and `reason` on a stock adjustment, and
 * a stock adjustment has BOTH reason and notes. Nothing is broken by that —
 * every screen reads its own column — but it meant "find the document where
 * someone wrote ALLAN" could not be asked at all.
 *
 * Rather than rename columns on a live system, the names are mapped here once
 * and the search reads this list. Adding a document to the global search is a
 * row in this table, not a new query.
 *
 * `page` is the permission key from the Users screen: the search returns it
 * with every hit and the client hides what that user may not open, so the
 * search can never show a cashier the contents of a payment voucher.
 *
 * `db` says which book the rows live in: 'tenant' is the depot's own (or HQ's,
 * on the HQ host), 'master' is the shared one where deposits and inter-branch
 * transfers live.
 */

// Every entry: what to search, what to show, and where tapping it goes.
const SOURCES = [
  // ── Money out ────────────────────────────────────────────────────────────
  { key: 'pv',            label: 'Payment Voucher',   db: 'tenant', table: 'payment_vouchers',
    cols: ['description'], number: 'voucher_number', date: 'date', amount: 'amount',
    page: 'PaymentVoucher', path: '/accounting/payment-vouchers' },
  { key: 'ap_payment',    label: 'AP Payment',        db: 'tenant', table: 'ap_payments',
    cols: ['description'], number: 'payment_number', date: 'date', amount: 'amount',
    page: 'AccountPayables', path: '/accounting/account-payables' },
  { key: 'cash_transfer', label: 'Cash Transfer',     db: 'tenant', table: 'cash_transfers',
    cols: ['description'], number: 'transfer_number', date: 'date', amount: 'amount',
    page: 'CashBook', path: '/accounting/cash-book' },

  // ── Money in ─────────────────────────────────────────────────────────────
  { key: 'cr',            label: 'Cash Receipt',      db: 'tenant', table: 'cash_receipts',
    cols: ['description'], number: 'receipt_number', date: 'date', amount: 'amount',
    page: 'CashReceipt', path: '/accounting/cash-receipts' },
  { key: 'cash_report',   label: 'Cash Report',       db: 'tenant', table: 'cash_reports',
    cols: ['comment'], number: null, date: 'date', amount: 'total',
    page: 'CashReport', path: '/pos/cash-report' },
  // No number of its own — it is identified by its receipt and its date.
  { key: 'cust_payment',  label: 'Customer Payment',  db: 'tenant', table: 'customer_payments',
    cols: ['notes', 'reference'], number: null, date: 'payment_date', amount: 'amount',
    page: 'AccountReceivables', path: '/accounting/account-receivables' },
  { key: 'deposit',       label: 'Deposit',           db: 'master', table: 'cash_deposits',
    cols: ['notes'], number: 'deposit_number', date: 'deposit_date', amount: 'amount',
    page: 'CashBook', path: '/accounting/cash-book?tab=deposits', branchCol: 'from_slug' },

  // ── Stock ────────────────────────────────────────────────────────────────
  { key: 'credit_note',   label: 'Credit Note',       db: 'tenant', table: 'supplier_credit_notes',
    cols: ['notes', 'reference'], number: 'credit_note_number', date: 'date', amount: 'amount',
    page: 'CreditNotes', path: '/accounting/credit-notes' },
  { key: 'grn',           label: 'GRN',               db: 'tenant', table: 'grn',
    cols: ['notes'], number: 'grn_number', date: 'date', amount: 'total_amount',
    page: 'IncomingStock', path: '/stock/incoming' },
  { key: 'adjustment',    label: 'Stock Adjustment',  db: 'tenant', table: 'stock_adjustments',
    cols: ['reason', 'notes'], number: 'adjustment_number', date: 'date', amount: null,
    page: 'StockReconciliation', path: '/stock/reconciliation' },
  { key: 'reconciliation', label: 'Stock Reconciliation', db: 'tenant', table: 'stock_reconciliations',
    cols: ['notes'], number: null, date: 'count_date', amount: null,
    page: 'StockReconciliation', path: '/stock/reconciliation' },
  { key: 'siv',           label: 'Store Issue (SIV)', db: 'tenant', table: 'siv',
    cols: ['notes'], number: 'siv_number', date: 'date', amount: null,
    page: 'IncomingStock', path: '/stock/incoming' },
  { key: 'sales_return',  label: 'Sales Damage',      db: 'tenant', table: 'sales_returns',
    cols: ['notes', 'confirm_notes'], number: 'return_number', date: 'date', amount: null,
    page: 'SalesReturns', path: '/stock/sales-returns' },
  { key: 'empty_return',  label: 'Empty Return',      db: 'tenant', table: 'empty_returns',
    cols: ['notes'], number: 'return_number', date: 'date', amount: 'total_amount',
    page: 'EmptyVouchers', path: '/stock/empty-vouchers' },
  { key: 'empty_voucher', label: 'Empty Voucher',     db: 'tenant', table: 'empty_vouchers',
    cols: ['notes', 'void_reason'], number: 'voucher_number', date: 'issued_at', amount: null,
    page: 'EmptyVouchers', path: '/stock/empty-vouchers' },
  { key: 'transfer',      label: 'Branch Transfer',   db: 'master', table: 'stock_transfers',
    cols: ['notes'], number: 'transfer_number', date: 'created_at', amount: null,
    page: 'BranchTransfers', path: '/stock/transfers', branchCol: 'from_slug' },
  { key: 'hq_purchase',   label: 'HQ Purchase',       db: 'master', table: 'hq_purchases',
    cols: ['notes'], number: 'purchase_number', date: 'date', amount: null,
    page: 'HQPurchases', path: '/hq/purchases', branchCol: 'destination_slug' },
  { key: 'hq_grn',        label: 'HQ GRN',            db: 'master', table: 'hq_grns',
    cols: ['notes'], number: 'grn_number', date: 'date', amount: 'final_payable',
    page: 'HQGrnArchive', path: '/hq/grn-archive', branchCol: 'branch_slug' },
];

module.exports = { SOURCES };
