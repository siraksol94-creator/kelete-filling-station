/**
 * server-tenant.js â€” Multi-tenant web server (port 5300)
 *
 * Handles requests for *.keletezm.com.
 * Reads the subdomain from the X-Tenant header (set by Nginx),
 * opens the correct tenant DB, and routes all API calls into it.
 *
 * No sync service â€” desktop devices sync via the main server (port 5300).
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// â”€â”€â”€ Uploads dir (tenant uploads live inside TENANTS_DIR/<slug>/uploads) â”€â”€â”€â”€â”€
// Resolved per-request in routes via req.uploadsDir (set by tenant middleware).
// For the tenant server, a shared base dir is used; subfolders are per-tenant.
const uploadsBase = process.env.TENANTS_DIR
  || path.join(__dirname, '..', 'tenants');

const fs = require('fs');
if (!fs.existsSync(uploadsBase)) fs.mkdirSync(uploadsBase, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// â”€â”€â”€ Tenant middleware â€” MUST come before all routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(require('./middleware/tenant'));

// â”€â”€â”€ Static file serving for uploaded images â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Each tenant's uploads live at TENANTS_DIR/<slug>/uploads/
// The URL pattern is /uploads/<filename> â€” served from the correct tenant folder
app.use('/uploads', (req, res, next) => {
  const host = (req.headers['x-tenant'] || req.hostname || '').toLowerCase();
  const slug = host.split('.')[0];
  const tenantUploads = path.join(uploadsBase, slug, 'uploads');
  express.static(tenantUploads)(req, res, next);
});

// â”€â”€â”€ API Routes (identical to main server) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use('/api/auth',             require('./routes/auth'));
app.use('/api/products',         require('./routes/products'));
app.use('/api/categories',       require('./routes/categories'));
app.use('/api/main-categories',  require('./routes/mainCategories'));
app.use('/api/units',            require('./routes/units'));
app.use('/api/orders',           require('./routes/orders'));
app.use('/api/grn',              require('./routes/grn'));
app.use('/api/empty-returns',    require('./routes/emptyReturns'));
// v1.13.67 â€” customer-side bearer voucher for empty containers.
app.use('/api/empty-vouchers',   require('./routes/emptyVouchers'));
app.use('/api/credit-notes',     require('./routes/supplierCreditNotes'));
app.use('/api/capital-account',  require('./routes/capitalAccount'));
app.use('/api/dividend-account', require('./routes/dividendAccount'));
app.use('/api/shareholders',     require('./routes/shareholders'));
app.use('/api/loans',            require('./routes/loans'));
app.use('/api/siv',              require('./routes/siv'));
app.use('/api/cash-receipts',    require('./routes/cashReceipts'));
app.use('/api/payment-vouchers', require('./routes/paymentVouchers'));
app.use('/api/pv-types',         require('./routes/pvTypes'));
app.use('/api/cash-book',        require('./routes/cashBook'));
app.use('/api/account-payables', require('./routes/accountPayables'));
app.use('/api/suppliers',        require('./routes/suppliers'));
app.use('/api/customers',        require('./routes/customers'));
app.use('/api/users',            require('./routes/users'));
app.use('/api/dashboard',        require('./routes/dashboard'));
app.use('/api/settings',         require('./routes/settings'));
app.use('/api/inventory',        require('./routes/inventory'));
app.use('/api/cash-reports',     require('./routes/cashReport'));
app.use('/api/currency-exchanges', require('./routes/currencyExchanges'));
app.use('/api/stock-adjustments',require('./routes/stockAdjustments'));
app.use('/api/stock-count',      require('./routes/stockCount'));
app.use('/api/stock-reconciliation', require('./routes/stockReconciliation'));
app.use('/api/customer-payments', require('./routes/customerPayments'));
// Production module removed for Kelete system.
// app.use('/api/production',       require('./routes/production'));
app.use('/api/sales-returns',    require('./routes/salesReturns'));
app.use('/api/ap-payments',      require('./routes/apPayments'));
app.use('/api/attachments',      require('./routes/attachments'));
app.use('/api/discount-requests',require('./routes/discountRequests'));
app.use('/api/sync',             require('./routes/sync'));
app.use('/api/updates',          require('./routes/updates'));
// v1.13.39 â€” ZRA routes were missing on server-tenant.js (VPS runs this
// file, Electron runs server.js). That's why the Settings â†’ ZRA page
// showed 404 on every fetch. Same pattern as [[project-butchery-pos-tenant-two-server-files]].
app.use('/api/zra',              require('./routes/zra'));
app.use('/api/fx-rates',         require('./routes/fxRates'));
app.use('/api/tenant-admin',     require('./routes/tenantAdmin'));
app.use('/api/hq',               require('./routes/hq'));
app.use('/api/hq/purchases',     require('./routes/hqPurchases'));
app.use('/api/hq/suppliers',     require('./routes/hqSuppliers'));
app.use('/api/hq/damages',       require('./routes/hqDamages'));
app.use('/api/hq/products',      require('./routes/hqProducts'));
app.use('/api/hq/grns',          require('./routes/hqGrns'));
// v1.10.0 â€” branch confirms received qty + invoice on a HQ PO. The actual
// GRN is then generated by HQ via /api/hq/grns/generate.
app.use('/api/branch/po-receipts', require('./routes/branchReceipts'));
app.use('/api/transfers',        require('./routes/transfers'));
app.use('/api/cash-deposits',    require('./routes/cashDeposits'));
app.use('/api/notifications',    require('./routes/notifications'));
app.use('/api/chat',             require('./routes/chat'));
app.use('/api/system',           require('./routes/system'));
app.use('/admin',                require('./routes/admin'));

// --- Kelete fuel-station modules ---
app.use('/api/fuel-grades',      require('./routes/fuelGrades'));
app.use('/api/tanks',            require('./routes/tanks'));
app.use('/api/pumps',            require('./routes/pumps'));
app.use('/api/fleet-customers',  require('./routes/fleetCustomers'));
app.use('/api/fuel-deliveries',  require('./routes/fuelDeliveries'));
app.use('/api/attendant-shifts', require('./routes/attendantShifts'));
app.use('/api/fuel-sales',       require('./routes/fuelSales'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', mode: 'tenant', timestamp: new Date().toISOString() });
});

// â”€â”€â”€ Global error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.TENANT_PORT || 5300;
app.listen(PORT, () => {
  console.log(`Kelete tenant server running on port ${PORT}`);

  // â”€â”€â”€ v1.9.0 â€” Layer 1: boot-time HQâ†’Branch mirror sweep â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Fires once on server start so any drift accumulated while the server
  // was down (HQ added products, a branch DB got reset, etc.) heals
  // before the first request lands. Async â€” we don't block listen() on
  // it; if the sweep crashes the rest of the server keeps running.
  setImmediate(() => {
    try {
      const { defaultDb } = require('./config/database');
      const { listTenants } = require('./config/masterDb');
      const { getTenantDb } = require('./config/tenantDb');
      const { mirrorAllHqToBranches } = require('./middleware/hqPush');
      const t0 = Date.now();
      // 2026-09-13 â€” itemClassesIfMissing: the ZRA item-class catalogue (~158k
      // rows) is copied only into a branch that lacks it. Copying it into all
      // sixteen on every restart blocked the server for minutes after a deploy.
      const r = mirrorAllHqToBranches(defaultDb, { listTenants, getTenantDb, itemClassesIfMissing: true });
      const totals = Object.values(r.per_branch || {}).reduce((a, b) => {
        a.pushed  += (b.products.pushed  + b.categories.pushed  + b.units.pushed  + b.main_categories.pushed);
        a.updated += (b.products.updated + b.categories.updated + b.units.updated + b.main_categories.updated);
        return a;
      }, { pushed: 0, updated: 0 });
      console.log(`[hq-mirror] Boot sweep done in ${Date.now() - t0}ms â€” ${r.branch_count} branch(es), ${totals.pushed} inserted, ${totals.updated} updated`);
    } catch (e) {
      console.error('[hq-mirror] Boot sweep failed:', e.message);
    }
  });

  // v1.13.94 â€” background ZRA retry queue. Sweeps every registered
  // tenant every 60s and re-fires saveSales for orders stuck in
  // zra_status='FAILED'. Ops can still manual-retry per order via
  // POST /api/orders/:id/retry-zra. Fully cron-managed â€” no manual
  // wiring needed once the branch has VSDC configured.
  //
  // 2026-08-28 â€” the VPS is no longer the primary retrier. Sales are rung
  // on the Electron tills and each till now retries its OWN orders (see
  // server.js). Both acting at once meant the same sale was sent twice a
  // minute apart and ZRA answered 924 to whichever lost. The VPS keeps a
  // 30-minute grace so it only picks up orders a till has clearly
  // abandoned â€” switched off, crashed, or replaced.
  try {
    // 2026-08-30 â€” grace back to 0 for the web-only go-live.
    //
    // The 30-minute wait added in v1.13.150 exists so the VPS does not race
    // an Electron till that is retrying the same sale. Correct once tills are
    // deployed â€” but the first launch is WEB ONLY (plus an Android Capacitor
    // client, which also talks to this server), so there is no till to race.
    // The VPS is the only retrier, and telling it to wait half an hour would
    // leave a failed fiscalisation sitting for 30 minutes instead of 60
    // seconds.
    //
    // PUT THIS BACK TO 30 * 60 * 1000 when Electron tills go out.
    require('./services/zraRetryQueue').start({ graceMs: 0 });
  } catch (e) {
    console.error('[zra-retry] failed to arm queue:', e.message);
  }
});
