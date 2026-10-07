const path = require('path');
const fs = require('fs');
const { openDb } = require('./database');
const { initTenantDb } = require('./migrations');

// Tenant DB files live here: /var/www/kelete-pos-tenant/tenants/<slug>.db
// On Electron the install tree is read-only, so keep them beside the tenant
// DB in userData instead. Same reasoning as masterDb.js.
const TENANTS_DIR = process.env.TENANTS_DIR
  || (process.env.ELECTRON_USER_DATA
        ? path.join(process.env.ELECTRON_USER_DATA, 'tenants')
        : path.join(__dirname, '..', '..', 'tenants'));

const cache = new Map(); // slug â†’ Database instance

// 2026-08-28 â€” a till is ONE branch and holds only its own book.
//
// The VPS keeps every branch side by side, so getTenantDb('buseko') there is
// just a file open. On a till it is not: the file does not exist, and the old
// path tried to mkdir into the read-only Program Files install folder,
// which Windows refuses â€” EPERM on the Transfers screen.
//
// Moving the folder alone would be WORSE than the error: the till would
// happily create an empty buseko.db and post Buseko's stock deduction into
// it. That looks like success and silently writes real stock into a book
// nobody reads. So: the till's own slug resolves to its own database, and a
// foreign slug is refused outright. Callers that genuinely need another
// branch's book must go through the VPS, which has them all.
function ownSlugIfElectron() {
  if (!process.env.ELECTRON_USER_DATA) return null;   // VPS â€” every book is local
  try {
    const { defaultDb } = require('./database');
    return defaultDb.prepare(
      "SELECT value FROM sync_config WHERE key = 'branch_slug' LIMIT 1"
    ).get()?.value || null;
  } catch (_) { return null; }
}

function getTenantDb(slug) {
  if (cache.has(slug)) return cache.get(slug);

  if (process.env.ELECTRON_USER_DATA) {
    const own = ownSlugIfElectron();
    const { defaultDb } = require('./database');
    if (own && slug === own) return defaultDb;        // our own branch â€” this IS its book
    const err = new Error(
      `This computer only holds the ${own || 'local'} branch. ` +
      `Working with ${slug} needs an internet connection so the server can do it.`
    );
    err.status = 409;
    err.foreignBranch = slug;
    throw err;
  }

  if (!fs.existsSync(TENANTS_DIR)) {
    fs.mkdirSync(TENANTS_DIR, { recursive: true });
  }

  const dbPath = path.join(TENANTS_DIR, `${slug}.db`);
  const isNew = !fs.existsSync(dbPath);
  const db = openDb(dbPath);

  if (isNew) {
    console.log(`[tenant] Initialising new DB for: ${slug}`);
  } else {
    console.log(`[tenant] Running migrations for existing DB: ${slug}`);
  }
  initTenantDb(db);

  cache.set(slug, db);

  // â”€â”€â”€ v1.9.0 â€” Layer 2: on-register auto-mirror â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The first time we open a brand-new branch DB, copy every HQ-owned row
  // (main_categories, categories, units, products) into it so the branch
  // launches with HQ's catalogue already populated. Without this, new
  // branches (e.g. mansa1 after activation) come up with 0 products â€”
  // pushProductToBranches only fires on EDIT at HQ, never on first sight.
  //
  // setImmediate so we don't block the caller (tenant middleware) â€” the
  // first /products request races a touch but the next refresh will be
  // fully populated. Requires deferred require() because hqPush imports
  // are loaded by server.js after this module, and database/masterDb are
  // both pre-existing here.
  if (isNew) {
    setImmediate(() => {
      try {
        const { defaultDb } = require('./database');
        const { listTenants } = require('./masterDb');
        const { mirrorAllHqToBranches } = require('../middleware/hqPush');
        const t0 = Date.now();
        const r = mirrorAllHqToBranches(defaultDb, {
          listTenants,
          getTenantDb,
          targetSlug: slug,
        });
        const b = (r.per_branch || {})[slug];
        if (b) {
          console.log(`[hq-mirror] On-register sweep for "${slug}" done in ${Date.now() - t0}ms â€” products: ${b.products.pushed} inserted, ${b.products.updated} updated; categories: ${b.categories.pushed}; units: ${b.units.pushed}`);
        }
      } catch (e) {
        console.error(`[hq-mirror] On-register sweep for "${slug}" failed:`, e.message);
      }
    });
  }

  return db;
}

module.exports = { getTenantDb, TENANTS_DIR };
