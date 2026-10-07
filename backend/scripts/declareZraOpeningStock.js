/**
 * declareZraOpeningStock.js — one-shot ZRA opening-balance declaration
 * (2026-08-26, found during T10A UAT prep)
 *
 * ── The problem ───────────────────────────────────────────────────────
 * ZRA holds TWO independent stock figures per item:
 *
 *   1. Stock Inventory  — the residual WE push via saveStockMaster
 *                         (rsdQty = products.current_stock). Correct:
 *                         verified matching CIS item-for-item.
 *   2. Opening/Closing  — a figure ZRA COMPUTES ITSELF by summing every
 *                         stock MOVEMENT we have ever sent them
 *                         (saveStockItems).
 *
 * Nothing ever declared the pre-go-live opening balance as a MOVEMENT,
 * so ZRA's computed ledger starts every item at zero. Real post-go-live
 * movements (sales, transfers, adjustments) then stack on that false
 * zero, which is why ZRA's Opening/Closing report shows NEGATIVE closing
 * stock (e.g. AQUA CLEAR 1000mls: residual 973, computed closing −9;
 * BLACK LABEL 750mls: residual 761, computed closing −82).
 *
 * ── The fix ───────────────────────────────────────────────────────────
 * Send ONE Adjustment-In movement per item for the opening balance, so
 * ZRA's own arithmetic reconciles:
 *
 *     opening + (movements already recorded) = residual
 *     e.g. AQUA CLEAR: 982 + (−9) = 973  ✓
 *
 * Therefore:  opening = residual − movements_already_recorded
 *
 * Both inputs come from ZRA'S OWN REPORTS, not from our guesses:
 *   residual  → Stock Management ▸ Stock Inventory      (Excel Download)
 *   movements → Stock Management ▸ Opening/Closing stock (Closing column)
 *
 * saveNonSaleStockChain also re-pushes saveStockMaster with rsdQty =
 * products.current_stock, so the residual is UNCHANGED by this script —
 * only the movement ledger is topped up. That is deliberate and safe.
 *
 * ── Why the numbers are hardcoded ─────────────────────────────────────
 * This writes irreversibly to a government fiscal ledger. The table below
 * was derived from ZRA's own exports and reviewed line-by-line before
 * running. It is NOT recomputed at runtime from a live API, because
 * /stock/selectStockItems does not expose residuals at all and returns
 * only a subset of movements — see
 * memory/project_zra_selectstockitems_reality.md for that writeup.
 *
 * ── Usage (on VPS) ────────────────────────────────────────────────────
 *   node backend/scripts/declareZraOpeningStock.js garden            # dry-run
 *   node backend/scripts/declareZraOpeningStock.js garden --commit   # fire
 *
 *   # the ~52 products ZRA has NO stock record for (never sold/received
 *   # since go-live). opening = current_stock; zero-stock items skipped.
 *   node backend/scripts/declareZraOpeningStock.js garden --remaining
 *   node backend/scripts/declareZraOpeningStock.js garden --remaining --commit
 *
 *   --chunk=N   items per movement record (default 10)
 *
 * Dry-run is the DEFAULT. Nothing is transmitted without --commit.
 * Idempotent only in the sense that it is safe to dry-run repeatedly —
 * running --commit twice WOULD double-declare, so run it once per mode.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const db = require('../config/database');
const { getTenantDb } = require('../config/tenantDb');
const vsdc = require('../services/vsdcClient');

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const slug = args.find(a => !a.startsWith('--'));

if (!slug) {
  console.error('Usage: node backend/scripts/declareZraOpeningStock.js <tenant-slug> [--commit]');
  process.exit(1);
}

// ── Reviewed opening balances ─────────────────────────────────────────
// opening = ZRA residual − ZRA computed closing (both from ZRA exports).
// `verified: false` marks rows whose arithmetic did NOT land on the
// expected seeded round number, meaning some movements were likely
// outside the report's date window. Those are SKIPPED unless
// --include-unverified is passed, because a wrong opening balance is
// permanent.
const OPENING_ROWS = [
  { itemCd: 'ZM2NTBX0000023', name: 'SIMBA 120g',                  residual: 1000, closing:   0, opening: 1000, verified: true  },
  { itemCd: 'ZM2NTBX0000046', name: 'BUDWEISER',                   residual: 1000, closing:   0, opening: 1000, verified: true  },
  { itemCd: 'ZM2NTBX0000032', name: 'BEER BOTTLE',                 residual:  999, closing:  -1, opening: 1000, verified: true  },
  { itemCd: 'ZM2NTBX0000060', name: 'BLACK LABEL CANNED',          residual:  999, closing:  -1, opening: 1000, verified: true  },
  { itemCd: 'ZM2NTBX0000027', name: 'AQUA CLEAR 500mls',           residual:  999, closing:  -1, opening: 1000, verified: true  },
  { itemCd: 'ZM2NTBX0000013', name: 'COKE RGB 300mls',             residual:  999, closing:  -1, opening: 1000, verified: true  },
  { itemCd: 'ZM2NTBX0000033', name: 'EMPTY S/D',                   residual:  998, closing:  -2, opening: 1000, verified: true  },
  { itemCd: 'ZM2NTBX0000039', name: 'AQUA SAVANA WATER 500mls',    residual:  998, closing:  -2, opening: 1000, verified: true  },
  { itemCd: 'ZM2NTBX0000026', name: 'AQUA CLEAR 1000mls',          residual:  973, closing:  -9, opening:  982, verified: true  },
  { itemCd: 'ZM2NTBX0000062', name: 'BLACK LABEL 750mls',          residual:  761, closing: -82, opening:  843, verified: true  },
  { itemCd: 'ZM2NTBX0000028', name: 'Appletiser/Grapetiser 300ml', residual:  980, closing:   0, opening:  980, verified: true  },
  // ── Not landing on the expected round seed — movements likely fall
  //    outside the Opening/Closing date window that was queried.
  { itemCd: 'ZM2NTBX0000034', name: 'EMPTY ZB',                    residual:  997, closing:  -2, opening:  999, verified: false },
  { itemCd: 'ZM2NTBX0000031', name: 'BEER BOX',                    residual:  997, closing:  -2, opening:  999, verified: false },
  { itemCd: 'ZM2NTBX0000063', name: 'MOSI CANNED',                 residual:  998, closing:  -3, opening: 1001, verified: false },
  { itemCd: 'ZM2NTBX0000065', name: 'MOSI 750ml',                  residual:  999, closing:   0, opening:  999, verified: false },
  { itemCd: 'ZM2NTBX0000056', name: 'CASTLE LITE 660mls',          residual:  999, closing:   0, opening:  999, verified: false },
  { itemCd: 'ZM2NTBX0000038', name: 'AQUA SAVANA WATER 750mls',    residual:  999, closing:   0, opening:  999, verified: false },
];

const includeUnverified = args.includes('--include-unverified');
const remainingMode = args.includes('--remaining');
// Chunk the transmission so one bad item cannot reject the whole batch.
// Learned from the 910 failure: VSDC validates the entire request and
// rejects it outright, so a single unregistered/malformed item would
// otherwise take every other item down with it.
const chunkArg = args.find(a => a.startsWith('--chunk='));
const CHUNK = chunkArg ? Math.max(1, parseInt(chunkArg.split('=')[1], 10) || 10) : 10;

(async () => {
  const tenantDb = getTenantDb(slug);
  const cfg = tenantDb.prepare(
    'SELECT tenant_id, zra_enabled, zra_sdc_id, zra_tpin, zra_bhf_id FROM business_settings ORDER BY id ASC LIMIT 1'
  ).get();

  if (!cfg) { console.error(`No business_settings row in tenant "${slug}".`); process.exit(1); }
  if (!cfg.zra_enabled) { console.error(`ZRA is disabled for tenant "${slug}".`); process.exit(1); }
  if (!cfg.zra_sdc_id)  { console.error(`Tenant "${slug}" has no initialized VSDC device.`); process.exit(1); }

  console.log(`\nTenant : ${slug}  (TPIN ${cfg.zra_tpin}, bhfId ${cfg.zra_bhf_id})`);
  console.log(`Mode   : ${commit ? '*** COMMIT — will transmit to ZRA ***' : 'dry-run (nothing transmitted)'}\n`);

  // ── --remaining mode ────────────────────────────────────────────────
  // The 17 rows in OPENING_ROWS are every item that appeared in ZRA's
  // Stock Inventory export — i.e. every item ZRA has ANY stock record
  // for. Garden carries ~69 products, so the rest have never had a
  // single stock movement transmitted and ZRA holds nothing for them.
  //
  // The moment one of those is first sold, the same defect reappears for
  // it individually: saveStockMaster sends the correct residual, but
  // ZRA's computed ledger starts at zero and the sale drives it negative.
  // Declaring their opening balance up-front prevents that.
  //
  // For these, opening = current_stock outright — there are no recorded
  // movements to subtract. Items at zero stock are skipped: they need no
  // opening, and a later GRN will build their ledger correctly from zero.
  const DECLARED = new Set(OPENING_ROWS.map(r => r.itemCd));
  let rows, skipped = [];
  if (remainingMode) {
    rows = tenantDb.prepare(
      `SELECT COALESCE(zra_item_cd, code) AS itemCd, name, current_stock
         FROM products
        WHERE deleted_at IS NULL
          AND sync_id IS NOT NULL
          AND COALESCE(zra_item_cd, code) IS NOT NULL
          AND COALESCE(current_stock, 0) > 0
        ORDER BY name`
    ).all()
      .filter(p => !DECLARED.has(String(p.itemCd)))
      .map(p => ({
        itemCd: String(p.itemCd),
        name: p.name,
        residual: null,     // ZRA holds no stock record for these
        closing: 0,         // no movements recorded, so nothing to subtract
        verified: true,
      }));
    console.log(`--remaining: ${rows.length} product(s) with stock and no ZRA stock record.`);
    console.log(`             (${DECLARED.size} already declared are excluded.)\n`);
  } else {
    rows = OPENING_ROWS.filter(r => r.verified || includeUnverified);
    skipped = OPENING_ROWS.filter(r => !r.verified && !includeUnverified);
  }

  // Resolve each itemCd to a local product so saveNonSaleStockChain can
  // look up its ZRA classification fields. Match on zra_item_cd first,
  // falling back to code (products created after the one-time ZM-code
  // backfill carry their plain code and legitimately have no
  // zra_item_cd — vsdcClient's own saveItem uses the same fallback).
  const lines = [];
  const unmatched = [];
  for (const r of rows) {
    const p = tenantDb.prepare(
      `SELECT id, sync_id, name, current_stock
         FROM products
        WHERE deleted_at IS NULL AND COALESCE(zra_item_cd, code) = ?
        LIMIT 1`
    ).get(r.itemCd);
    if (!p || !p.sync_id) { unmatched.push(r); continue; }
    // 2026-08-26 (post first dry-run) — opening is derived from LOCAL
    // current_stock, NOT from the ZRA residual in the table above.
    //
    // The first dry-run surfaced three items where the ZRA residual sits
    // 1 below local stock (BEER BOTTLE, BLACK LABEL CANNED, EMPTY S/D) —
    // a stock push that never landed. Deriving the opening from that
    // stale residual would have baked the gap in permanently. Local
    // current_stock is the truth (and is itself rebuilt from the
    // stock_movements ledger by the boot-time healer), so:
    //
    //     opening = local_current_stock - movements_ZRA_already_recorded
    //
    // which makes ZRA's computed closing land exactly on real stock.
    // saveNonSaleStockChain separately re-pushes saveStockMaster with
    // rsdQty = current_stock, so the stale residual is corrected by the
    // same run as a side effect. The table's `residual`/`opening` values
    // are retained purely as a cross-check display.
    const localQty = Number(p.current_stock) || 0;
    const opening = localQty - Number(r.closing);
    lines.push({
      row: r,
      product: p,
      opening,
      line: { product_sync_id: p.sync_id, quantity: opening, unit: null },
    });
  }

  console.log('  itemCd            name                            local  ZRA resid  ZRA closing   OPENING');
  console.log('  ' + '-'.repeat(96));
  let residualGaps = 0;
  for (const { row: r, product: p, opening } of lines) {
    console.log(
      '  ' + r.itemCd.padEnd(18) + String(r.name).slice(0, 30).padEnd(32) +
      String(p.current_stock).padStart(7) + String(r.residual ?? '—').padStart(11) +
      String(r.closing).padStart(13) + String(opening).padStart(10)
    );
    // Local vs ZRA residual should already agree. Where they don't, a
    // stock push never landed — the run corrects it via saveStockMaster.
    // Skipped in --remaining mode: ZRA holds no residual for those at all.
    if (r.residual !== null && Math.abs(Number(p.current_stock) - r.residual) > 0.001) {
      residualGaps++;
      console.log(`      ^^ ZRA residual is stale by ${(Number(p.current_stock) - r.residual).toFixed(0)} (a stock push never landed). This run re-pushes it from local stock.`);
    }
  }
  if (residualGaps) {
    console.log(`\n  ${residualGaps} item(s) had a stale ZRA residual — corrected by this run, but worth`);
    console.log('  investigating why those pushes failed (check the ZRA audit log for errors).');
  }

  if (skipped.length) {
    console.log(`\n  SKIPPED ${skipped.length} unverified row(s) (arithmetic did not land on the expected seed):`);
    for (const r of skipped) {
      const p = tenantDb.prepare(
        `SELECT current_stock FROM products
          WHERE deleted_at IS NULL AND COALESCE(zra_item_cd, code) = ? LIMIT 1`
      ).get(r.itemCd);
      const localQty = p ? Number(p.current_stock) || 0 : null;
      const wouldBe = localQty === null ? '?' : localQty - Number(r.closing);
      console.log(`    ${r.itemCd.padEnd(18)} ${String(r.name).slice(0, 30).padEnd(32)} local ${String(localQty ?? '?').padStart(6)}  ZRA closing ${String(r.closing).padStart(4)}  opening would be ${wouldBe}`);
    }
    console.log('    Re-run ZRA Opening/Closing with a wider date range, correct the table, then re-run.');
    console.log('    (Pass --include-unverified to declare them anyway — not recommended.)');
  }
  if (unmatched.length) {
    console.log(`\n  UNMATCHED ${unmatched.length} row(s) — no local product for that item code:`);
    for (const r of unmatched) console.log(`    ${r.itemCd}  ${r.name}`);
  }

  if (!lines.length) { console.log('\nNothing to declare. Exiting.\n'); process.exit(0); }

  console.log(`\n  ${lines.length} item(s) ready to declare as Adjustment-In (sarTyCd 06).`);

  if (!commit) {
    console.log('\nDry-run only — nothing transmitted. Re-run with --commit to send.\n');
    process.exit(0);
  }

  // Transmit in chunks. VSDC validates the WHOLE request and rejects it
  // outright (see the 910 4dp failure), so batching limits the blast
  // radius: one unregistered or malformed item takes down only its own
  // chunk, and the surviving chunks tell us which group to investigate.
  // sarNo must be unique per movement record — derived from the clock so
  // a re-run cannot collide with a previous run's records.
  const batches = [];
  for (let i = 0; i < lines.length; i += CHUNK) batches.push(lines.slice(i, i + CHUNK));
  const baseSarNo = Math.floor(Date.now() / 1000) % 2147483647;

  console.log(`\n  Transmitting ${lines.length} item(s) in ${batches.length} record(s) of up to ${CHUNK}...\n`);

  let failures = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const sarNo = baseSarNo + b;
    const names = batch.map(l => l.row.name).join(', ');
    process.stdout.write(`  [${b + 1}/${batches.length}] sarNo ${sarNo} · ${batch.length} item(s) ... `);
    try {
      const res = await db.runWithDb(tenantDb, () => vsdc.saveNonSaleStockChain(
        cfg.tenant_id,
        sarNo,
        {
          customer_name: 'Opening Balance Declaration',
          remark: 'Pre-Smart-Invoice opening stock, declared once so ZRA computed closing reconciles to residual',
        },
        batch.map(l => l.line),
        vsdc.SAR_TY_CD.ADJUSTMENT_IN
      ));
      const stockCd  = res.stock?.parsed?.resultCd  || res.stock?.resultCd  || (res.stock?.error ? 'ERR' : '?');
      const masterCd = res.master?.parsed?.resultCd || res.master?.resultCd || (res.master?.error ? 'ERR' : '?');
      if (res.ok === false || stockCd !== '000') {
        failures++;
        console.log(`FAILED (stock ${stockCd}, master ${masterCd})`);
        console.log(`        items: ${names}`);
        const msg = res.stock?.parsed?.resultMsg || res.stock?.error;
        if (msg) console.log(`        ${msg}`);
      } else {
        console.log(`ok (stock ${stockCd}, master ${masterCd})`);
      }
    } catch (e) {
      failures++;
      console.log(`ERROR — ${e.message}`);
      console.log(`        items: ${names}`);
    }
  }

  console.log(
    failures
      ? `\n  ${batches.length - failures}/${batches.length} record(s) accepted, ${failures} failed. Re-run only the failed items.\n`
      : '\n  All records accepted. Verify on ZRA Opening/Closing that closing now equals your stock.\n'
  );
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
