import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { CurrencyProvider } from './context/CurrencyContext';
import { isHqHost, setBranchSlug } from './services/api';

// HQ-only route gate. Every /hq/* page assumes a multi-branch HQ context
// (master.db queries, branch picker, cross-branch reports). On a branch
// install (per-branch subdomain OR Electron desktop) those queries
// either fail or return empty + the UI is meaningless. So if the host
// isn't HQ we redirect anywhere a /hq/* URL is hit. Sidebar entries are
// already hidden by Layout.js — this catches direct URL navigation +
// retained-from-prior-session URLs after a v1.3.12 update.
const HqRoute = ({ children }) => {
  if (!isHqHost()) return <Navigate to="/" replace />;
  return children;
};

import Layout from './components/Layout';
import Login from './pages/Login';
import Setup from './pages/Setup';
import LicenseBanner from './components/LicenseBanner';
import Dashboard from './pages/Dashboard';
import POS from './pages/POS';
import Cashier from './pages/Cashier';
import Dispatch from './pages/Dispatch';
import HqOverview from './pages/HqOverview';
import HqSalesReport from './pages/HqSalesReport';
import HqRouteSales from './pages/HqRouteSales';
import HqVatReport from './pages/HqVatReport';
import HqConsolidatedProfit from './pages/HqConsolidatedProfit';
import HqInventoryReport from './pages/HqInventoryReport';
import HqCashPosition from './pages/HqCashPosition';
import Messages from './pages/Messages';
import StockTransfers from './pages/StockTransfers';
import HqPurchases from './pages/HqPurchases';
import HqSuppliers from './pages/HqSuppliers';
import HqConfirmGrn from './pages/HqConfirmGrn';
import HqGrnArchive from './pages/HqGrnArchive';
import HqVariances from './pages/HqVariances';
import HqConfirmDamages from './pages/HqConfirmDamages';
import HqProducts from './pages/HqProducts';
import IncomingStock from './pages/IncomingStock';
import ItemDetails from './pages/ItemDetails';
import QuickPrice from './pages/QuickPrice'; // v1.8.34 — bulk price editor
import OpeningBalance from './pages/OpeningBalance'; // v1.13.153 — branch opening stock + price
import BranchPrices from './pages/BranchPrices'; // v1.13.154 — HQ sets one branch's prices
import GRN from './pages/GRN';
import EmptyReturns from './pages/EmptyReturns';
import SIV from './pages/SIV';
import Inventory from './pages/Inventory';
import CashReceipt from './pages/CashReceipt';
import PaymentVoucher from './pages/PaymentVoucher';
import CashBook from './pages/CashBook';
import HQDeposits from './pages/HQDeposits';
import FxRates from './pages/FxRates';
import AccountPayables from './pages/AccountPayables';
import HqApApprovals from './pages/HqApApprovals';
import CustomerEmptyBalances from './pages/CustomerEmptyBalances';
import EmptyVouchers from './pages/EmptyVouchers';
import AccountReceivables from './pages/AccountReceivables';
import CreditNotes from './pages/CreditNotes';
import CapitalAccount from './pages/CapitalAccount';
import DividendAccount from './pages/DividendAccount';
import Shareholders from './pages/Shareholders';
import PendingApprovals from './pages/PendingApprovals';
import LoanAccount from './pages/LoanAccount';
import ProfitReport from './pages/ProfitReport';
import Suppliers from './pages/Suppliers';
import Customers from './pages/Customers';
import Profile from './pages/Profile';
import SystemSettings from './pages/SystemSettings';
import ZraConfig from './pages/ZraConfig';
import ZraPurchases from './pages/ZraPurchases';
import ZraImports from './pages/ZraImports';
import Users from './pages/Users';
import SalesReport from './pages/SalesReport';
import SalesInventory from './pages/SalesInventory';
import CashReport from './pages/CashReport';
import StockAdjustment from './pages/StockAdjustment';
import StockReconciliation from './pages/StockReconciliation';
import Categories from './pages/Categories';
import BinCard from './pages/BinCard';
import SalesBinCard from './pages/SalesBinCard';
import VatReport from './pages/VatReport';
import SalesReturn from './pages/SalesReturn';
import ExpiryReport from './pages/ExpiryReport';
import StockCount from './pages/StockCount';
import CustomerDisplay from './pages/CustomerDisplay';
import Backups from './pages/Backups';
// Kelete fuel-station modules
import FuelGrades from './pages/FuelGrades';
import Tanks from './pages/Tanks';
import PumpsNozzles from './pages/PumpsNozzles';
import FleetCustomers from './pages/FleetCustomers';
import FuelDeliveries from './pages/FuelDeliveries';
import AttendantShifts from './pages/AttendantShifts';
import FuelPOS from './pages/FuelPOS';

const isWeb = !navigator.userAgent.toLowerCase().includes('electron');

const PrivateRoute = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <div>Loading...</div>;
  return isAuthenticated ? children : <Navigate to="/login" />;
};

// Blocks page access if user lacks the required permission(s)
// perms: array of permission strings — user needs at least one
// adminOnly: true = only Administrators can access
// allAccessOnly: true = only users with All/Full Access (not Custom) can access
const PermRoute = ({ children, perms = [], adminOnly = false, allAccessOnly = false }) => {
  const { user, hasPermission, hasPageAccess, isAllAccess } = useAuth();
  if (!user) return <Navigate to="/login" />;
  const fallback = () => {
    // 2026-08-30 — mirror DefaultRedirect: on HQ, prefer HQ pages, otherwise a
    // blocked HQ user bounces to /no-access with permissions they can use.
    const lists = isHqHost() ? [HQ_PRIORITY, CUSTOM_PRIORITY] : [CUSTOM_PRIORITY];
    for (const list of lists) {
      for (const entry of list) {
        if (hasPageAccess(entry.page)) return entry.path;
      }
    }
    return '/no-access';
  };
  if (allAccessOnly && !isAllAccess()) return <Navigate to={fallback()} />;
  if (adminOnly && user.role !== 'Administrator') return <Navigate to={fallback()} />;
  if (perms.length > 0 && !perms.some(p => hasPermission(p))) return <Navigate to={fallback()} />;
  return children;
};

// Redirects based on access level:
// - All access → /dashboard
// - POS only → /pos
// - Custom permissions → /settings/profile (safe landing page everyone can see)
const broaderPerms = ['Sales','Stock','GRN','SIV','Accounting','Suppliers','Customers','Reports'];

const CUSTOM_PRIORITY = [
  { page: 'POS',              path: '/pos' },
  { page: 'SalesReport',      path: '/pos/sales-report' },
  { page: 'SalesInventory',   path: '/pos/sales-inventory' },
  { page: 'SalesStockCard',   path: '/pos/sales-stock-card' },
  { page: 'CashReport',       path: '/pos/cash-report' },
  { page: 'SalesBinCard',     path: '/pos/sales-bin-card' },
  { page: 'Items',            path: '/stock/items' },
  { page: 'QuickPrice',       path: '/stock/quick-price' },
  { page: 'OpeningBalance',   path: '/stock/opening-balance' },
  { page: 'BranchPrices',     path: '/stock/branch-prices' },
  { page: 'GRN',              path: '/stock/grn' },
  { page: 'SIV',              path: '/stock/siv' },
  { page: 'SalesReturns',     path: '/stock/sales-damages' },
  { page: 'StockAdjustment',  path: '/stock/adjustments' },
  { page: 'StockReconciliation', path: '/stock/reconciliation' },
  { page: 'StockCount',       path: '/stock/stock-count' },
  { page: 'Categories',       path: '/stock/categories' },
  { page: 'BinCard',          path: '/stock/bin-card' },
  { page: 'ExpiryReport',     path: '/stock/expiry-report' },
  { page: 'Inventory',        path: '/stock/inventory' },
  { page: 'CashReceipt',      path: '/accounting/cash-receipts' },
  { page: 'PaymentVoucher',   path: '/accounting/payment-vouchers' },
  { page: 'CashBook',         path: '/accounting/cash-book' },
  { page: 'HQDeposits',       path: '/accounting/hq-deposits' },
  { page: 'FxRates',          path: '/accounting/fx-rates' },
  { page: 'AccountPayables',  path: '/accounting/account-payables' },
  { page: 'APCheck',          path: '/accounting/ap-approvals' },
  { page: 'APApprove',        path: '/accounting/ap-approvals' },
  { page: 'APPay',            path: '/accounting/ap-approvals' },
  { page: 'AccountReceivables', path: '/accounting/account-receivables' },
  { page: 'CapitalAccount',   path: '/accounting/capital-account' },
  { page: 'DividendAccount',  path: '/accounting/dividend-account' },
  { page: 'Shareholders',     path: '/accounting/shareholders' },
  { page: 'LoanAccount',      path: '/accounting/loans' },
  { page: 'ProfitReport',     path: '/accounting/profit-report' },
  { page: 'Suppliers',        path: '/suppliers-customers/suppliers' },
  { page: 'Customers',        path: '/suppliers-customers/customers' },
];

// 2026-08-30 — the HQ equivalent of CUSTOM_PRIORITY.
//
// CUSTOM_PRIORITY is entirely branch pages. Once HQ Overview stopped being
// the unconditional landing page, an HQ user who lacks it had nothing in that
// list to fall back to and would have been dumped on /no-access despite
// holding real HQ permissions (AP, purchases, GRN archive). This list gives
// the same first-accessible-page search an HQ-shaped answer; the branch list
// still runs after it, for the pages both sides share.
const HQ_PRIORITY = [
  { page: 'HQOverview',        path: '/hq/overview' },
  { page: 'HQSalesReport',     path: '/hq/sales-report' },
  { page: 'HQVatReport',       path: '/hq/vat-report' },
  { page: 'HQInventoryReport', path: '/hq/inventory-report' },
  { page: 'HQCashPosition',    path: '/hq/cash-position' },
  { page: 'HQConsolidatedProfit', path: '/hq/consolidated-profit' },
  { page: 'HQPurchases',       path: '/hq/purchases' },
  { page: 'HQConfirmGrn',      path: '/hq/confirm-grn' },
  { page: 'HQGrnArchive',      path: '/hq/grn-archive' },
  { page: 'HQVariances',       path: '/hq/variances' },
  { page: 'HQConfirmDamages',  path: '/hq/confirm-damages' },
  { page: 'HQSuppliers',       path: '/hq/suppliers' },
];

const DefaultRedirect = () => {
  const { user, isAllAccess, hasPageAccess } = useAuth();
  if (!user) return <Navigate to="/login" />;
  // HQ users land on the cross-branch overview by default. Use the
  // shared isHqHost() so the Electron-is-never-HQ rule (v1.3.12) is
  // honoured here too — otherwise a localhost Electron would land on
  // /hq/overview, get bounced by HqRoute back to "/", land here again,
  // re-redirect to /hq/overview… infinite loop.
  // 2026-08-30 — only land on the overview if the user may actually see it.
  // This used to be unconditional, which is how a Staff account ended up on a
  // cross-branch revenue page it had no permission for. Everyone else falls
  // through to the same first-accessible-page search as a branch user.
  if (isHqHost() && (isAllAccess() || hasPageAccess('HQOverview'))) {
    return <Navigate to="/hq/overview" />;
  }
  if (isAllAccess()) return <Navigate to="/dashboard" />;
  // Find first page the custom user has access to. On HQ, try the HQ pages
  // first — the branch list below still applies for pages both sides share.
  const lists = isHqHost() ? [HQ_PRIORITY, CUSTOM_PRIORITY] : [CUSTOM_PRIORITY];
  for (const list of lists) {
    for (const entry of list) {
      if (hasPageAccess(entry.page)) return <Navigate to={entry.path} />;
    }
  }
  return <Navigate to="/no-access" />;
};

function AppRoutes() {
  const [syncChecked, setSyncChecked]     = useState(false);
  const [isConfigured, setIsConfigured]   = useState(true); // optimistic default
  const [hasUsers, setHasUsers]           = useState(true); // optimistic default
  const [licenseStatus, setLicenseStatus] = useState(null);
  const [tenantNotFound, setTenantNotFound] = useState(false);

  useEffect(() => {
    fetch('/api/sync/status')
      .then(async r => {
        if (r.status === 404 && isWeb) { setTenantNotFound(true); setSyncChecked(true); return null; }
        return r.json();
      })
      .then(async data => {
        if (!data) return;
        // On web, subdomain identifies the tenant — skip Setup, go straight to login
        setIsConfigured(isWeb ? true : !!data.isConfigured);
        // Electron-only: cache this install's branch slug for pages that
        // need it client-side (e.g. Inter-Branch Transfers). Derived from
        // vpsUrl like "https://kassumbalesa1.keletezm.com" -> "kassumbalesa1".
        if (!isWeb && data.vpsUrl) {
          try {
            const host = new URL(data.vpsUrl).hostname;
            const derivedSlug = host.split('.')[0];
            if (derivedSlug) setBranchSlug(derivedSlug);
          } catch { /* ignore malformed vpsUrl */ }
        }
        if (data.isConfigured && data.tenantId && data.tenantId !== 'local-only') {
          const base = data.vpsUrl || '';
          // 3-second timeout so the license check doesn't hang forever if VPS is unreachable.
          // It's fire-and-forget anyway — the app still loads even if this fails.
          const licenseAbort = new AbortController();
          const licenseTimer = setTimeout(() => licenseAbort.abort(), 3000);
          fetch(`${base}/api/sync/license-status?tenantId=${data.tenantId}`, { signal: licenseAbort.signal })
            .then(r => r.json())
            .then(setLicenseStatus)
            .catch(() => {})
            .finally(() => clearTimeout(licenseTimer));
        }
        // Check if any user accounts exist (desktop only, not logged in)
        if (!isWeb && !localStorage.getItem('token')) {
          try {
            const acctRes = await fetch('/api/auth/account-status');
            const acct = await acctRes.json();
            setHasUsers(acct.hasUsers);
          } catch (e) {}
        }
      })
      .catch(() => setIsConfigured(true))
      .finally(() => setSyncChecked(true));
  }, []); // eslint-disable-line

  if (!syncChecked) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9fafb' }}>
        <div style={{ fontSize: 32 }}>🍷</div>
      </div>
    );
  }

  if (tenantNotFound) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #fff1f1 0%, #fdf2f8 100%)' }}>
        <div style={{ background: '#fff', borderRadius: 16, padding: '48px 40px', width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.1)', textAlign: 'center' }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>🔒</div>
          <h1 style={{ color: '#dc2626', fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Subdomain Not Registered</h1>
          <p style={{ color: '#6b7280', fontSize: 14, lineHeight: 1.6, marginBottom: 24 }}>
            This subdomain has not been registered on Kelete.<br />
            Please contact <strong style={{ color: '#111827' }}>SIDAN IT & Business Solutions</strong> to get your account set up.
          </p>
          <div style={{ background: '#f9fafb', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#374151' }}>
            📞 Contact us to register your business and get started.
          </div>
        </div>
      </div>
    );
  }

  // Not configured OR configured but no users yet (Step 1 done, Step 2 not done)
  if (!isConfigured || (!hasUsers && !localStorage.getItem('token'))) {
    return (
      <Setup
        onComplete={() => { setIsConfigured(true); setHasUsers(true); }}
        startAtCreateAdmin={isConfigured && !hasUsers}
      />
    );
  }

  // Cloud license expired — block access
  if (licenseStatus?.isExpired) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#fef2f2', padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>🔒</div>
        <h1 style={{ color: '#dc2626', fontSize: 24, marginBottom: 8 }}>License Expired</h1>
        <p style={{ color: '#7f1d1d', fontSize: 15, maxWidth: 400 }}>
          Your Kelete license expired on <strong>{licenseStatus.expiresAt?.substring(0,10)}</strong>.
          Please contact your software provider to renew your license.
        </p>
        <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 24 }}>
          Your data is safe and will be available once the license is renewed.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <LicenseBanner licenseStatus={licenseStatus} />
    <Routes>
      <Route path="/customer-display" element={<CustomerDisplay />} />
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Setup onComplete={() => { setIsConfigured(true); setHasUsers(true); }} />} />
      <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
        <Route index element={<DefaultRedirect />} />
        <Route path="dashboard" element={<PermRoute allAccessOnly><Dashboard /></PermRoute>} />
        {/* 2026-09-14 — Messages: every signed-in user, HQ and depots. */}
        <Route path="messages" element={<Messages />} />
        <Route path="pos" element={<PermRoute perms={['POS','Sales','POS:View','POS:Add','POS:Edit','POS:Delete']}><POS /></PermRoute>} />
        <Route path="pos/cashier"  element={<PermRoute perms={['Cashier','Cashier:View','Cashier:Add','Cashier:Edit','Cashier:Delete']}><Cashier /></PermRoute>} />
        <Route path="pos/dispatch" element={<PermRoute perms={['Dispatch','Dispatch:View','Dispatch:Add','Dispatch:Edit','Dispatch:Delete']}><Dispatch /></PermRoute>} />
        <Route path="hq/overview"         element={<HqRoute><PermRoute perms={['HQOverview','HQOverview:View','HQOverview:Add','HQOverview:Edit','HQOverview:Delete']}><HqOverview /></PermRoute></HqRoute>} />
        <Route path="hq/sales-report"     element={<HqRoute><HqSalesReport /></HqRoute>} />
        <Route path="hq/route-sales"      element={<HqRoute><HqRouteSales /></HqRoute>} />
        <Route path="hq/vat-report"       element={<HqRoute><PermRoute perms={['HQVatReport','HQVatReport:View']}><HqVatReport /></PermRoute></HqRoute>} />
        <Route path="hq/consolidated-profit" element={<HqRoute><PermRoute perms={['HQConsolidatedProfit','HQConsolidatedProfit:View']}><HqConsolidatedProfit /></PermRoute></HqRoute>} />
        <Route path="hq/inventory-report" element={<HqRoute><HqInventoryReport /></HqRoute>} />
        <Route path="hq/cash-position"    element={<HqRoute><HqCashPosition /></HqRoute>} />
        <Route path="hq/purchases"        element={<HqRoute><HqPurchases /></HqRoute>} />
        <Route path="hq/confirm-grn"      element={<HqRoute><HqConfirmGrn /></HqRoute>} />
        <Route path="hq/grn-archive"      element={<HqRoute><HqGrnArchive /></HqRoute>} />
        <Route path="hq/variances"        element={<HqRoute><HqVariances /></HqRoute>} />
        <Route path="hq/confirm-damages"  element={<HqRoute><HqConfirmDamages /></HqRoute>} />
        <Route path="hq/products"         element={<HqRoute><HqProducts /></HqRoute>} />
        <Route path="hq/suppliers"        element={<HqRoute><HqSuppliers /></HqRoute>} />
        <Route path="pos/sales-report" element={<PermRoute perms={['Sales','Reports','SalesReport:View','SalesReport:Add','SalesReport:Edit','SalesReport:Delete']}><SalesReport /></PermRoute>} />
        <Route path="pos/sales-inventory" element={<PermRoute perms={['Sales','Reports','SalesInventory:View','SalesInventory:Add','SalesInventory:Edit','SalesInventory:Delete']}><SalesInventory /></PermRoute>} />
        <Route path="pos/sales-stock-card" element={<PermRoute perms={['Sales','Reports','SalesInventory:View','Inventory:View','SalesStockCard:View']}><Inventory viewLocation="sales" /></PermRoute>} />
        <Route path="pos/cash-report" element={<PermRoute perms={['Sales','Reports','CashReport:View','CashReport:Add','CashReport:Edit','CashReport:Delete']}><CashReport /></PermRoute>} />
        <Route path="pos/sales-bin-card" element={<PermRoute perms={['Sales','Reports','SalesBinCard:View','SalesBinCard:Add','SalesBinCard:Edit','SalesBinCard:Delete']}><SalesBinCard /></PermRoute>} />
        <Route path="pos/vat-report" element={<PermRoute perms={['Sales','Reports','SalesReport:View','VATReport:View']}><VatReport /></PermRoute>} />
        <Route path="stock/items" element={<PermRoute perms={['Stock','GRN','SIV','Items:View','Items:Add','Items:Edit','Items:Delete']}><ItemDetails /></PermRoute>} />
        <Route path="stock/quick-price" element={<PermRoute perms={['Stock','Items:Edit','QuickPrice:View']}><QuickPrice /></PermRoute>} />
        <Route path="stock/opening-balance" element={<PermRoute perms={['Stock','Items:Edit','OpeningBalance:View']}><OpeningBalance /></PermRoute>} />
        {/* HQ only — the page exists to set a price at a branch OTHER than
            the one you are logged into, which is meaningless from a branch. */}
        <Route path="stock/branch-prices" element={<HqRoute><PermRoute perms={['Stock','Items:Edit','BranchPrices:View']}><BranchPrices /></PermRoute></HqRoute>} />
        <Route path="stock/grn" element={<PermRoute perms={['GRN','Stock','GRN:View','GRN:Add','GRN:Edit','GRN:Delete']}><GRN /></PermRoute>} />
        <Route path="stock/empty-returns" element={<PermRoute perms={['GRN','Stock','GRN:View','GRN:Add','GRN:Edit','GRN:Delete']}><EmptyReturns /></PermRoute>} />
        <Route path="stock/siv" element={<PermRoute perms={['SIV','Stock','SIV:View','SIV:Add','SIV:Edit','SIV:Delete']}><SIV /></PermRoute>} />
        <Route path="stock/inventory" element={<PermRoute perms={['Stock','GRN','SIV','Inventory:View']}><Inventory /></PermRoute>} />
        <Route path="stock/adjustments" element={<PermRoute perms={['Stock','StockAdjustment:View','StockAdjustment:Add','StockAdjustment:Edit','StockAdjustment:Delete']}><StockAdjustment /></PermRoute>} />
        <Route path="stock/reconciliation" element={<PermRoute perms={['Stock','StockReconciliation:View','StockReconciliation:Add','StockReconciliation:Edit','StockReconciliation:Delete']}><StockReconciliation /></PermRoute>} />
        <Route path="stock/categories" element={<PermRoute perms={['Stock','Categories:View','Categories:Add','Categories:Edit','Categories:Delete']}><Categories /></PermRoute>} />
        <Route path="stock/bin-card" element={<PermRoute perms={['Stock','GRN','SIV','BinCard:View']}><BinCard /></PermRoute>} />
        <Route path="stock/sales-damages" element={<PermRoute perms={['SIV','Stock','SalesReturns:View','SalesReturns:Add','SalesReturns:Edit','SalesReturns:Delete']}><SalesReturn /></PermRoute>} />
        {/* Legacy redirect: any deep links pointing at the old URL still work. */}
        <Route path="stock/sales-returns" element={<Navigate to="/stock/sales-damages" replace />} />
        <Route path="stock/expiry-report" element={<PermRoute perms={['Stock','GRN','ExpiryReport:View']}><ExpiryReport /></PermRoute>} />
        <Route path="stock/stock-count" element={<PermRoute perms={['Stock','StockCount:View','StockCount:Add']}><StockCount /></PermRoute>} />
        <Route path="stock/transfers"   element={<PermRoute perms={['Stock','GRN','SIV','Inventory:View','BranchTransfers:View']}><StockTransfers /></PermRoute>} />
        <Route path="stock/incoming"    element={<PermRoute perms={['Stock','GRN','SIV','Inventory:View','IncomingStock:View']}><IncomingStock /></PermRoute>} />
        <Route path="accounting/cash-receipts" element={<PermRoute perms={['Accounting','CashReceipt:View','CashReceipt:Add','CashReceipt:Edit','CashReceipt:Delete']}><CashReceipt /></PermRoute>} />
        <Route path="accounting/payment-vouchers" element={<PermRoute perms={['Accounting','PaymentVoucher:View','PaymentVoucher:Add','PaymentVoucher:Edit','PaymentVoucher:Delete']}><PaymentVoucher /></PermRoute>} />
        <Route path="accounting/cash-book" element={<PermRoute perms={['Accounting','CashBook:View','CashBook:Add','CashBook:Edit','CashBook:Delete']}><CashBook /></PermRoute>} />
        <Route path="accounting/hq-deposits" element={<PermRoute perms={['Accounting','CashBook:View','CashBook:Add']}><HQDeposits /></PermRoute>} />
        <Route path="accounting/fx-rates" element={<PermRoute perms={['Accounting','FxRates','FxRates:View','FxRates:Add','FxRates:Edit','FxRates:Delete']}><FxRates /></PermRoute>} />
        <Route path="accounting/account-payables" element={<PermRoute perms={['Accounting','AccountPayables:View','AccountPayables:Add','AccountPayables:Edit','AccountPayables:Delete']}><AccountPayables /></PermRoute>} />
        <Route path="accounting/ap-approvals" element={<PermRoute perms={['APConfirm:View','APConfirm:Add','APConfirm:Edit','APCheck:View','APCheck:Add','APCheck:Edit','APApprove:View','APApprove:Add','APApprove:Edit','APPay:View','APPay:Add','APPay:Edit']}><HqApApprovals /></PermRoute>} />
        <Route path="accounting/account-receivables" element={<PermRoute perms={['Accounting','AccountReceivables:View','AccountReceivables:Add','AccountReceivables:Edit','AccountReceivables:Delete']}><AccountReceivables /></PermRoute>} />
        <Route path="accounting/credit-notes" element={<PermRoute perms={['Accounting','CreditNotes:View','CreditNotes:Add','CreditNotes:Edit','CreditNotes:Delete']}><CreditNotes /></PermRoute>} />
        <Route path="accounting/capital-account" element={<PermRoute perms={['Accounting','CapitalAccount:View','CapitalAccount:Add','CapitalAccount:Edit','CapitalAccount:Delete']}><CapitalAccount /></PermRoute>} />
        <Route path="accounting/dividend-account" element={<PermRoute perms={['Accounting','DividendAccount:View','DividendAccount:Add','DividendAccount:Edit','DividendAccount:Delete']}><DividendAccount /></PermRoute>} />
        <Route path="accounting/shareholders" element={<PermRoute perms={['Accounting','Shareholders:View','Shareholders:Add','Shareholders:Edit','Shareholders:Delete']}><Shareholders /></PermRoute>} />
        <Route path="accounting/loans" element={<PermRoute perms={['Accounting','LoanAccount:View','LoanAccount:Add','LoanAccount:Edit','LoanAccount:Delete']}><LoanAccount /></PermRoute>} />
        <Route path="accounting/profit-report" element={<PermRoute perms={['Accounting','ProfitReport:View']}><ProfitReport /></PermRoute>} />
        <Route path="suppliers-customers/suppliers" element={<PermRoute perms={['Suppliers','Suppliers:View','Suppliers:Add','Suppliers:Edit','Suppliers:Delete']}><Suppliers /></PermRoute>} />
        <Route path="suppliers-customers/customers" element={<PermRoute perms={['Customers','Customers:View','Customers:Add','Customers:Edit','Customers:Delete']}><Customers /></PermRoute>} />
        {/* v1.13.62 — customer empties deposit tracking (legacy — kept for
            existing balance data; superseded by voucher system below) */}
        <Route path="suppliers-customers/empty-balances" element={<PermRoute perms={['Customers','Customers:View','Customers:Add','Customers:Edit']}><CustomerEmptyBalances /></PermRoute>} />
        {/* v1.13.67 — bearer voucher system (Controller station).
            Standalone from Customers — anyone can return empties. */}
        <Route path="store/empty-vouchers" element={<PermRoute perms={['Store','GRN:View','GRN:Add','SIV:View','SIV:Add','EmptyVouchers:View']}><EmptyVouchers /></PermRoute>} />
        <Route path="settings/profile" element={<PermRoute allAccessOnly><Profile /></PermRoute>} />
        <Route path="settings/system" element={<PermRoute allAccessOnly><SystemSettings /></PermRoute>} />
        <Route path="settings/zra" element={<PermRoute allAccessOnly adminOnly><ZraConfig /></PermRoute>} />
        {/* v1.13.85 — supplier invoice pull is HQ-only. All Kelete procurement
            flows through HQ (drop-ship model), so branches never see raw
            supplier invoices. HqRoute redirects branch hosts back to /. */}
        <Route path="hq/zra-purchases" element={<HqRoute><PermRoute allAccessOnly adminOnly><ZraPurchases /></PermRoute></HqRoute>} />
        <Route path="hq/zra-imports" element={<HqRoute><PermRoute allAccessOnly adminOnly><ZraImports /></PermRoute></HqRoute>} />
        <Route path="settings/users" element={<PermRoute allAccessOnly adminOnly><Users /></PermRoute>} />
        <Route path="settings/backups" element={<PermRoute allAccessOnly adminOnly><Backups /></PermRoute>} />
        <Route path="approvals/discounts" element={<PermRoute allAccessOnly adminOnly><PendingApprovals /></PermRoute>} />
        {/* Kelete fuel-station modules */}
        <Route path="fuel/pos"           element={<FuelPOS />} />
        <Route path="fuel/shifts"        element={<AttendantShifts />} />
        <Route path="fuel/deliveries"    element={<FuelDeliveries />} />
        <Route path="fuel/tanks"         element={<Tanks />} />
        <Route path="fuel/pumps"         element={<PumpsNozzles />} />
        <Route path="fuel/grades"        element={<FuelGrades />} />
        <Route path="fuel/fleet"         element={<FleetCustomers />} />
        <Route path="no-access" element={
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#6b7280', textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
            <h2 style={{ margin: '0 0 8px', color: '#111827' }}>No Pages Available</h2>
            <p style={{ margin: 0, fontSize: 14 }}>You don't have access to any pages. Contact your administrator.</p>
          </div>
        } />
      </Route>
    </Routes>
    </div>
  );
}

function App() {
  // v1.10.86 — HQ gets its own purple palette so operators can tell at a
  // glance they're on HQ vs a branch. Host doesn't change at runtime, so
  // a one-shot class toggle on mount is enough; CSS variable overrides
  // under `body.hq-theme` in index.css swing --primary/--sidebar-* etc.
  useEffect(() => {
    document.body.classList.toggle('hq-theme', isHqHost());
  }, []);

  // Render customer display immediately — no auth, no sync check, no license check
  if (window.location.pathname === '/customer-display') {
    return <CustomerDisplay />;
  }
  return (
    <LanguageProvider>
      <AuthProvider>
        <CurrencyProvider>
          <Router>
            <AppRoutes />
          </Router>
        </CurrencyProvider>
      </AuthProvider>
    </LanguageProvider>
  );
}

export default App;
