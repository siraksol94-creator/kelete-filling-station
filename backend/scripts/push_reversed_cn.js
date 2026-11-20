/**
 * push_reversed_cn.js — 2026-09-03
 *
 * File BOTH LEGS of a reversal that happened while the branch was offline:
 * the original sale, then the credit note against it.
 *
 * Push All to ZRA deliberately skips Reversed orders (routes/zra.js:857)
 * because it can only send the sale, and a sale filed without its credit
 * note overstates the branch's output tax. The live reversal path in
 * routes/orders.js:2136 sends the CN inline — but only when the original
 * was already signed:
 *
 *     if (result.zra_rcpt_no && result.zra_sdc_id) { ...rcptTyCd 'R'... }
 *
 * A branch that was offline at reversal time never satisfied that, so it
 * kept a local credit note and ZRA saw neither leg. This closes the gap.
 *
 * Order matters and cannot be swapped: the CN carries
 * orgInvoice { orgInvcNo, orgSdcId }, which only exists once the sale has
 * been signed. A CN sent first is an un-linked reversal and ZRA rejects it
 * — that was the v1.13.70 orgIncNo typo bug.
 *
 * DRY RUN BY DEFAULT — prints what it would send and files nothing.
 *
 *   node backend/scripts/push_reversed_cn.js                # dry run, all branches
 *   node backend/scripts/push_reversed_cn.js katete         # dry run, one branch
 *   node backend/scripts/push_reversed_cn.js katete --send  # file it
 *
 * Stops the whole run at the first refusal rather than continuing, so a
 * failure can never leave a sale filed with no credit note behind it.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const dbProxy = require('../config/database');
const { getTenantDb } = require('../config/tenantDb');
const { listTenants } = require('../config/masterDb');
const vsdc = require('../services/vsdcClient');
const { retryOrder } = require('../services/zraRetryQueue');

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const ONLY = args.filter(a => !a.startsWith('--'))[0] || null;
const money = n => 'K' + (Number(n) || 0).toFixed(2);

// Preserve whatever reason the operator chose at reversal time; fall back
// to '07' (other) only where none was recorded, matching routes/orders.js.
const reasonFor = o => o.zra_cn_rfd_rsn_cd || '07';

async function run() {
  const tenants = listTenants().filter(t => !ONLY || t.slug === ONLY);
  let filed = 0, skipped = 0;

  for (const t of tenants) {
    let db;
    try { db = getTenantDb(t.slug); } catch (_) { continue; }

    await dbProxy.runWithDb(db, async () => {
      const cfg = db.prepare(
        'SELECT tenant_id, zra_enabled FROM business_settings WHERE tenant_id = ? LIMIT 1'
      ).get(t.tenant_id);
      if (!cfg || !cfg.zra_enabled) return;

      const rows = db.prepare(
        "SELECT * FROM orders" +
        " WHERE zra_status = 'PENDING' AND deleted_at IS NULL" +
        "   AND COALESCE(status, '') = 'Reversed'" +
        " ORDER BY COALESCE(sales_at, created_at) ASC, id ASC"
      ).all();
      if (!rows.length) return;

      console.log('\n=== ' + t.slug + ' — ' + rows.length + ' reversal(s)');

      for (const order of rows) {
        const items = db.prepare(
          'SELECT oi.quantity, oi.reversed_quantity, oi.unit_price, oi.discount' +
          '  FROM order_items oi' +
          ' WHERE oi.order_id = ? AND oi.deleted_at IS NULL'
        ).all(order.id);

        const sale = items.reduce((s, i) => s + i.quantity * (i.unit_price - (i.discount || 0)), 0);
        const cn = items.reduce((s, i) => s + (i.reversed_quantity || 0) * (i.unit_price - (i.discount || 0)), 0);

        // A partial reversal needs a CN carrying only the refunded lines.
        // This script sends the whole invoice both ways, which is correct
        // ONLY for a full reversal — so refuse to touch anything else.
        if (Math.abs(sale - cn) > 0.005) {
          console.log('  ' + order.order_number + '  PARTIAL (sale ' + money(sale) +
            ' vs cn ' + money(cn) + ') — SKIPPED, handle individually');
          skipped++;
          continue;
        }

        console.log('  ' + order.order_number + '  sale ' + money(sale) +
          ' -> CN ' + money(cn) + '  reason=' + reasonFor(order));
        if (!SEND) { skipped++; continue; }

        // The date each leg actually happened, not today's.
        const saleDate = order.sales_at ? new Date(order.sales_at) : undefined;
        const cnDate = order.zra_cn_signed_at ? new Date(order.zra_cn_signed_at) : saleDate;

        // ── leg 1: the original sale ──────────────────────────────────────
        const s = await retryOrder(t.tenant_id, order.id, { saleDate });
        if (!s || (!s.ok && !s.skipped)) {
          console.error('     SALE REFUSED — ' + ((s && (s.error || s.reason)) || 'unknown'));
          throw new Error('stopping: sale leg failed');
        }

        const signed = db.prepare(
          'SELECT zra_rcpt_no, zra_sdc_id FROM orders WHERE id = ?'
        ).get(order.id);
        if (!signed || !signed.zra_rcpt_no || !signed.zra_sdc_id) {
          console.error('     SALE gave no rcptNo/sdcId — cannot link the CN');
          throw new Error('stopping: no original to link');
        }
        console.log('     sale filed  rcptNo=' + signed.zra_rcpt_no);

        // ── leg 2: the credit note ────────────────────────────────────────
        const zraItems = db.prepare(
          'SELECT oi.*, p.name AS product_name, p.code AS product_code,' +
          '       p.zra_item_cd, p.zra_item_cls_cd, p.zra_pkg_unit_cd,' +
          '       p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp' +
          '  FROM order_items oi' +
          '  LEFT JOIN products p ON p.id = oi.product_id' +
          ' WHERE oi.order_id = ? AND oi.deleted_at IS NULL'
        ).all(order.id);

        const rfdRsnCd = reasonFor(order);
        const c = await vsdc.saveSales(t.tenant_id, order, zraItems, {
          actor: 'system',
          actorNm: 'Offline reversal backfill',
          rcptTyCd: 'R',
          rfdRsnCd: rfdRsnCd,
          skipOrderPersist: true,
          orgInvoice: { orgInvcNo: signed.zra_rcpt_no, orgSdcId: signed.zra_sdc_id },
          saleDate: cnDate,
        });
        if (!c.ok) {
          console.error('     CN REFUSED — ' + (c.error || c.resultCd));
          console.error('     WARNING: the sale is now filed with no credit note against it.');
          throw new Error('stopping: credit note leg failed');
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
          rfdRsnCd,
          order.id
        );

        // Stock chain for the cancellation, as the live reversal path does.
        if (c.itemList) {
          const snaps = zraItems.map(it => ({
            itemCd: it.zra_item_cd || it.product_code || String(it.product_id),
            rsdQty: parseFloat(
              (db.prepare('SELECT current_stock FROM products WHERE id = ?')
                .get(it.product_id) || {}).current_stock || 0
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

  console.log('\n' + (SEND ? 'FILED' : 'DRY RUN') + ' — ' + filed +
    ' reversal(s) filed, ' + skipped + ' not sent');
  if (!SEND) console.log('Re-run with --send to transmit.');
}

run().then(() => process.exit(0)).catch(e => {
  console.error('\nSTOPPED: ' + e.message);
  process.exit(1);
});
