/**
 * push_partial_cn.js — 2026-09-03
 *
 * File the credit note for a PARTIAL refund taken while the branch was
 * offline. The original invoice is already signed; only the refund is
 * missing, which overstates output VAT by the refunded amount.
 *
 * Why this is separate from push_reversed_cn.js: that one resends the whole
 * invoice as the credit note, which is correct for a full reversal and would
 * OVER-CREDIT a partial. A partial CN carries only the refunded quantities,
 * built the way the live partial path does at routes/orders.js:2391:
 *
 *     propFrac  = reversed_quantity / quantity
 *     snapTaxbl = zra_vat_taxbl_amt * propFrac
 *     snapVat   = zra_vat_amt       * propFrac
 *
 * Two details from that path that are easy to get wrong and are reproduced
 * here deliberately:
 *   * the order passed to saveSales is a SHIM with no zra_cis_invc_no, so a
 *     NEW cisInvcNo is allocated for the note. Passing the real order reuses
 *     the invoice's own and VSDC answers 924 duplicate.
 *   * skipOrderPersist keeps the original invoice's fiscal fields intact —
 *     the order is still partially active, so the CN's rcptNo must not
 *     overwrite the sale's.
 *
 * Unlike a full reversal these orders are already SIGNED, so they never show
 * up in a pending/failed check. Find them by reversed_quantity, not status.
 *
 * ⚠ The 931 "CN 2× original" error was seen on 2026-08-26 and never
 * root-caused, and no partial CN has ever been accepted in production. Run
 * ONE order first, smallest value, and read the result before doing more.
 *
 * DRY RUN BY DEFAULT — prints the lines it would send and files nothing.
 *
 *   node backend/scripts/push_partial_cn.js                     # show all
 *   node backend/scripts/push_partial_cn.js livingstone         # show one branch
 *   node backend/scripts/push_partial_cn.js livingstone --send  # file it
 *   node backend/scripts/push_partial_cn.js livingstone --send --order 87
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const dbProxy = require('../config/database');
const { getTenantDb } = require('../config/tenantDb');
const { listTenants } = require('../config/masterDb');
const vsdc = require('../services/vsdcClient');

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const ONLY = args.filter(a => !a.startsWith('--'))[0] || null;
const oi = args.indexOf('--order');
const ORDER_ID = oi >= 0 && args[oi + 1] ? Number(args[oi + 1]) : null;
const money = n => 'K' + (Number(n) || 0).toFixed(2);

async function run() {
  const tenants = listTenants().filter(t => !ONLY || t.slug === ONLY);
  let filed = 0, listed = 0;

  for (const t of tenants) {
    let db;
    try { db = getTenantDb(t.slug); } catch (_) { continue; }

    await dbProxy.runWithDb(db, async () => {
      const cfg = db.prepare(
        'SELECT zra_enabled FROM business_settings WHERE tenant_id = ? LIMIT 1'
      ).get(t.tenant_id);
      if (!cfg || !cfg.zra_enabled) return;

      const rows = db.prepare(
        'SELECT * FROM orders o' +
        ' WHERE o.zra_status = \'SIGNED\' AND o.deleted_at IS NULL' +
        '   AND COALESCE(o.zra_cn_rcpt_no, 0) = 0' +
        '   AND EXISTS (SELECT 1 FROM order_items oi' +
        '                WHERE oi.order_id = o.id' +
        '                  AND COALESCE(oi.reversed_quantity, 0) > 0)' +
        ' ORDER BY o.id ASC'
      ).all().filter(o => !ORDER_ID || o.id === ORDER_ID);
      if (!rows.length) return;

      console.log('\n=== ' + t.slug);

      for (const order of rows) {
        const items = db.prepare(
          'SELECT oi.*, p.id AS p_id, p.code, p.name AS p_name,' +
          '       p.zra_item_cd, p.zra_item_cls_cd, p.zra_pkg_unit_cd,' +
          '       p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp' +
          '  FROM order_items oi' +
          '  LEFT JOIN products p ON p.id = oi.product_id' +
          ' WHERE oi.order_id = ? AND oi.deleted_at IS NULL' +
          '   AND COALESCE(oi.reversed_quantity, 0) > 0'
        ).all(order.id);
        if (!items.length) continue;

        // One CN line per refunded line, quantity = what was actually
        // refunded (already stored in the line's own unit).
        const cnLines = items.map(item => {
          const origQty = parseFloat(item.quantity) || 0;
          const refQty = parseFloat(item.reversed_quantity) || 0;
          const propFrac = origQty > 0 ? (refQty / origQty) : 0;
          const snapTaxbl = item.zra_vat_taxbl_amt != null && item.zra_vat_taxbl_amt !== ''
            ? Number(item.zra_vat_taxbl_amt) * propFrac : null;
          const snapVat = item.zra_vat_amt != null && item.zra_vat_amt !== ''
            ? Number(item.zra_vat_amt) * propFrac : null;
          return {
            product_id: item.p_id || item.product_id,
            product_code: item.code || null,
            product_name: item.p_name || null,
            quantity: refQty,
            unit: item.unit,
            unit_price: item.unit_price,
            discount: item.discount,
            zra_item_cd: item.zra_item_cd || null,
            zra_item_cls_cd: item.zra_item_cls_cd || null,
            zra_pkg_unit_cd: item.zra_pkg_unit_cd || null,
            zra_qty_unit_cd: item.zra_qty_unit_cd || null,
            zra_vat_cat_cd: item.zra_vat_cat_cd || null,
            zra_excise_ty_cd: item.zra_excise_ty_cd || null,
            zra_rrp: item.zra_rrp || null,
            zra_vat_cat_snap: item.zra_vat_cat_snap || null,
            zra_rrp_snap: item.zra_rrp_snap != null ? item.zra_rrp_snap : null,
            zra_vat_rate: item.zra_vat_rate != null ? item.zra_vat_rate : null,
            zra_vat_taxbl_amt: snapTaxbl,
            zra_vat_amt: snapVat,
          };
        });

        const cnTotal = cnLines.reduce(
          (s, l) => s + l.quantity * (l.unit_price - (l.discount || 0)), 0);

        console.log('  order#' + order.id + '  ' + order.order_number +
          '  orgInvc=' + order.zra_rcpt_no + '  CN ' + money(cnTotal));
        for (const l of cnLines) {
          console.log('      ' + String(l.product_name || l.product_code).slice(0, 34).padEnd(34) +
            ' qty=' + l.quantity + '  @' + l.unit_price +
            '  cat=' + (l.zra_vat_cat_snap || l.zra_vat_cat_cd || 'A') +
            '  rrp=' + (l.zra_rrp_snap != null ? l.zra_rrp_snap : (l.zra_rrp || 0)));
        }
        listed++;
        if (!SEND) continue;

        if (!order.zra_rcpt_no || !order.zra_sdc_id) {
          console.error('     no orgInvcNo/orgSdcId on the original — cannot link');
          throw new Error('stopping: original not signed');
        }

        // Shim, not the real order — see the header note on 924.
        const synthOrder = {
          id: order.id,
          customer_tpin: order.customer_tpin || null,
          customer_name: order.customer_name || null,
          payment_method: order.payment_method || 'Cash',
          discount: 0,
          zra_currency_ty_cd: order.zra_currency_ty_cd || 'ZMW',
          zra_exchange_rt: order.zra_exchange_rt || 1,
          lpo_number: order.lpo_number || null,
        };
        const rfdRsnCd = order.zra_cn_rfd_rsn_cd || '07';

        const c = await vsdc.saveSales(t.tenant_id, synthOrder, cnLines, {
          actor: 'system',
          actorNm: 'Offline partial-refund backfill',
          rcptTyCd: 'R',
          rfdRsnCd: rfdRsnCd,
          skipOrderPersist: true,
          orgInvoice: { orgInvcNo: order.zra_rcpt_no, orgSdcId: order.zra_sdc_id },
        });
        if (!c.ok) {
          console.error('     CN REFUSED — ' + (c.error || c.resultCd));
          throw new Error('stopping: credit note refused');
        }

        db.prepare(
          'UPDATE orders SET' +
          '  zra_cn_cis_invc_no = ?, zra_cn_rcpt_no = ?, zra_cn_intrl_data = ?,' +
          '  zra_cn_rcpt_sign = ?, zra_cn_sdc_id = ?, zra_cn_mrc_no = ?,' +
          '  zra_cn_vsdc_rcpt_pbct_date = ?, zra_cn_qr_code_url = ?,' +
          "  zra_cn_rfd_rsn_cd = ?, zra_cn_signed_at = datetime('now')," +
          "  updated_at = datetime('now'), synced = 0" +
          ' WHERE id = ?'
        ).run(
          c.cisInvcNo == null ? null : c.cisInvcNo,
          c.rcptNo == null ? null : c.rcptNo,
          c.intrlData == null ? null : c.intrlData,
          c.rcptSign == null ? null : c.rcptSign,
          c.sdcId == null ? null : c.sdcId,
          c.mrcNo == null ? null : c.mrcNo,
          c.vsdcRcptPbctDate == null ? null : c.vsdcRcptPbctDate,
          c.qrCodeUrl == null ? null : c.qrCodeUrl,
          rfdRsnCd, order.id
        );

        if (c.itemList) {
          const snaps = cnLines.map(l => ({
            itemCd: l.zra_item_cd || l.product_code || String(l.product_id),
            rsdQty: parseFloat(
              (db.prepare('SELECT current_stock FROM products WHERE id = ?')
                .get(l.product_id) || {}).current_stock || 0
            ) || 0,
          }));
          try {
            await vsdc.saveSaleStockChain(t.tenant_id, order, c.itemList, snaps, { isCredit: true });
          } catch (e) {
            console.error('     (stock chain deferred: ' + e.message + ')');
          }
        }

        console.log('     CN filed    rcptNo=' + c.rcptNo);
        filed++;
      }
    });
  }

  console.log('\n' + (SEND ? 'FILED' : 'DRY RUN') + ' — ' + listed +
    ' partial refund(s) found, ' + filed + ' filed');
  if (!SEND) console.log('Re-run with --send (start with ONE, the smallest).');
}

run().then(() => process.exit(0)).catch(e => {
  console.error('\nSTOPPED: ' + e.message);
  process.exit(1);
});
