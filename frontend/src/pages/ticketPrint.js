// Fuel credit/1Card invoice printing. Opens a new window with a proper
// A4 invoice (seller block + bill-to + line item + totals + signatures)
// and triggers print. Seller block is read from business_settings
// (Profile → Company) so each branch prints its own address.

const K = n => 'K ' + Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const L = n => Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function openPrint(html) {
  const w = window.open('', '_blank', 'width=900,height=1200');
  if (!w) { alert('Pop-ups blocked. Allow pop-ups to print.'); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); }, 300);
}

function invNo(id)   { return 'INV-' + String(id || 0).padStart(5, '0'); }
function fmtDate(d)  {
  if (!d) return '';
  const s = String(d);
  if (s.length >= 10) return s.slice(0, 10);
  return s;
}

// seller: { business_name, tpin, business_phone, business_email, business_address }
// logoUrl: absolute URL (string) or empty
export function printTicket(t, method, seller = {}, logoUrl = '') {
  const isCard = method === '1Card';
  const title = isCard ? 'ENGEN 1CARD INVOICE' : 'CREDIT INVOICE';
  const terms = isCard
    ? 'Charged to Engen 1Card. Reconciled against Engen monthly statement.'
    : 'Payable on account per agreed credit terms. All disputes within 7 days.';
  const html = `
<!doctype html><html><head><meta charset="utf-8"><title>${invNo(t.id)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; margin: 0; }
  .inv { max-width: 760px; margin: 0 auto; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1e3a8a; padding-bottom: 14px; margin-bottom: 18px; }
  .seller { display: flex; gap: 14px; align-items: flex-start; }
  .seller img { max-height: 70px; max-width: 180px; object-fit: contain; }
  .seller .name { font-size: 20px; font-weight: 800; color: #1e3a8a; letter-spacing: 0.5px; }
  .seller .meta { font-size: 11px; color: #374151; line-height: 1.5; margin-top: 4px; }
  .meta strong { color: #111; }
  .inv-meta { text-align: right; }
  .inv-meta .label { font-size: 22px; font-weight: 800; color: #111; letter-spacing: 1px; }
  .inv-meta table { border-collapse: collapse; margin-left: auto; margin-top: 8px; }
  .inv-meta td { padding: 2px 4px; font-size: 11px; }
  .inv-meta td.lbl { color: #6b7280; text-align: right; }
  .inv-meta td.val { color: #111; font-weight: 700; text-align: right; }
  .billto { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; margin-bottom: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .billto h4 { margin: 0 0 4px; font-size: 10px; color: #6b7280; letter-spacing: 1px; }
  .billto .big { font-size: 14px; font-weight: 700; color: #111; }
  .billto .ln  { font-size: 11px; color: #374151; }
  table.items { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  table.items th { background: #1e3a8a; color: #fff; font-size: 11px; text-align: left; padding: 8px 10px; letter-spacing: 0.5px; }
  table.items th.r, table.items td.r { text-align: right; }
  table.items td { padding: 10px; border-bottom: 1px solid #e5e7eb; font-size: 12px; }
  .totals { display: flex; justify-content: flex-end; margin-top: 10px; }
  .totals table { border-collapse: collapse; min-width: 280px; }
  .totals td { padding: 6px 10px; font-size: 12px; }
  .totals td.lbl { color: #6b7280; text-align: right; }
  .totals td.val { text-align: right; font-weight: 700; }
  .totals tr.grand td { font-size: 15px; border-top: 2px solid #1e3a8a; background: #eef2ff; color: #1e3a8a; }
  .terms { margin-top: 16px; padding: 10px 12px; background: #fffbeb; border-left: 4px solid #f59e0b; font-size: 11px; color: #78350f; }
  .sigs { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-top: 40px; }
  .sig .line { border-top: 1px solid #111; margin-bottom: 4px; }
  .sig .cap { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
  .foot { margin-top: 20px; font-size: 10px; color: #9ca3af; text-align: center; }
</style></head><body>
  <div class="inv">
    <div class="top">
      <div class="seller">
        ${logoUrl ? `<img src="${esc(logoUrl)}" alt="logo">` : ''}
        <div>
          <div class="name">${esc(seller.business_name || 'KELETE INVESTMENTS')}</div>
          <div class="meta">
            ${seller.tpin ? `<strong>TPIN:</strong> ${esc(seller.tpin)}<br>` : ''}
            ${seller.business_address ? esc(seller.business_address) + '<br>' : ''}
            ${seller.business_phone ? '<strong>Tel:</strong> ' + esc(seller.business_phone) + '<br>' : ''}
            ${seller.business_email ? '<strong>Email:</strong> ' + esc(seller.business_email) : ''}
          </div>
        </div>
      </div>
      <div class="inv-meta">
        <div class="label">${title}</div>
        <table>
          <tr><td class="lbl">Invoice No.</td><td class="val">${invNo(t.id)}</td></tr>
          <tr><td class="lbl">Date</td><td class="val">${esc(fmtDate(t.date || t.created_at))}</td></tr>
          <tr><td class="lbl">Shift</td><td class="val">#${t.shift_id || ''}</td></tr>
          <tr><td class="lbl">Attendant</td><td class="val">${esc(t.attendant_name || '')}</td></tr>
          ${t.receipt_number ? `<tr><td class="lbl">Ref</td><td class="val">${esc(t.receipt_number)}</td></tr>` : ''}
        </table>
      </div>
    </div>

    <div class="billto">
      <div>
        <h4>BILL TO</h4>
        <div class="big">${esc(t.customer_name || '')}</div>
        ${isCard && t.card_number ? `<div class="ln">Card No. ${esc(t.card_number)}</div>` : ''}
      </div>
      <div>
        <h4>VEHICLE</h4>
        <div class="big">${esc(t.vehicle_registration || '—')}</div>
      </div>
    </div>

    <table class="items">
      <thead><tr>
        <th style="width:50%">Description</th>
        <th class="r">Qty (L)</th>
        <th class="r">Unit Price</th>
        <th class="r">Amount</th>
      </tr></thead>
      <tbody>
        <tr>
          <td><strong>${esc((t.grade_name || 'Fuel').toUpperCase())}</strong><br>
              <span style="color:#6b7280;font-size:10px">Dispensed through nozzle on shift #${t.shift_id || ''}</span></td>
          <td class="r">${L(t.litres)}</td>
          <td class="r">${K(t.price_per_litre)}</td>
          <td class="r"><strong>${K(t.amount)}</strong></td>
        </tr>
      </tbody>
    </table>

    <div class="totals">
      <table>
        <tr><td class="lbl">Sub-total</td><td class="val">${K(t.amount)}</td></tr>
        <tr class="grand"><td class="lbl">TOTAL DUE</td><td class="val">${K(t.amount)}</td></tr>
      </table>
    </div>

    <div class="terms">${terms}</div>

    <div class="sigs">
      <div class="sig"><div class="line"></div><div class="cap">Authorised by</div></div>
      ${!isCard ? '<div class="sig"><div class="line"></div><div class="cap">Customer signature</div></div>' : '<div></div>'}
      <div class="sig"><div class="line"></div><div class="cap">Attendant signature</div></div>
    </div>

    <div class="foot">Printed ${new Date().toLocaleString()} · ${invNo(t.id)}</div>
  </div>
<script>window.onafterprint = function(){ window.close(); };</script>
</body></html>`;
  openPrint(html);
}

export function printTicketList(rows, method, filter, seller = {}, logoUrl = '') {
  const isCard = method === '1Card';
  const title = isCard ? 'Engen 1Card Invoices — List' : 'Credit Invoices — List';
  const totLitres = rows.reduce((s, r) => s + Number(r.litres || 0), 0);
  const totAmount = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const rowsHtml = rows.map(r => `
    <tr>
      <td>${esc(fmtDate(r.date || r.created_at))}</td>
      <td>${esc(invNo(r.id))}</td>
      <td>${esc(r.attendant_name || '')}</td>
      <td>${esc(r.customer_name || '')}${isCard && r.card_number ? ' · ' + esc(r.card_number) : ''}</td>
      <td>${esc(r.vehicle_registration || '')}</td>
      <td>${esc(r.grade_name || '')}</td>
      <td class="r">${L(r.litres)}</td>
      <td class="r">${K(r.price_per_litre)}</td>
      <td class="r"><strong>${K(r.amount)}</strong></td>
      <td>${esc(r.receipt_number || '')}</td>
    </tr>`).join('');
  const html = `
<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #000; margin: 0; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1e3a8a; padding-bottom: 10px; margin-bottom: 10px; }
  .hdr .name { font-size: 16px; font-weight: 800; color: #1e3a8a; }
  .hdr .meta { font-size: 10px; color: #374151; margin-top: 2px; }
  .hdr img { max-height: 50px; }
  h2 { font-size: 14px; margin: 0 0 2px; }
  .sub { font-size: 11px; color: #333; margin-bottom: 10px; }
  table.r { width: 100%; border-collapse: collapse; }
  table.r th, table.r td { border: 1px solid #999; padding: 5px 6px; font-size: 11px; text-align: left; vertical-align: top; }
  table.r th { background: #1e3a8a; color: #fff; }
  table.r td.r, table.r th.r { text-align: right; }
  tfoot td { font-weight: 700; background: #f9fafb; }
</style></head><body>
  <div class="hdr">
    <div>
      <div class="name">${esc(seller.business_name || 'KELETE INVESTMENTS')}</div>
      <div class="meta">
        ${seller.tpin ? 'TPIN: ' + esc(seller.tpin) + ' · ' : ''}
        ${seller.business_address ? esc(seller.business_address) + ' · ' : ''}
        ${seller.business_phone ? 'Tel: ' + esc(seller.business_phone) : ''}
      </div>
    </div>
    ${logoUrl ? `<img src="${esc(logoUrl)}" alt="logo">` : ''}
  </div>
  <h2>${title}</h2>
  <div class="sub">
    Range: <strong>${esc(filter?.from || '')}</strong> → <strong>${esc(filter?.to || '')}</strong>
    &nbsp;·&nbsp; Rows: <strong>${rows.length}</strong>
    &nbsp;·&nbsp; Printed: ${new Date().toLocaleString()}
  </div>
  <table class="r">
    <thead><tr>
      <th>Date</th><th>Invoice #</th><th>Attendant</th><th>${isCard ? 'Card Holder · #' : 'Customer'}</th>
      <th>Vehicle</th><th>Grade</th>
      <th class="r">Litres</th><th class="r">K/L</th><th class="r">Amount</th><th>Ref</th>
    </tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="10" style="text-align:center;color:#999;padding:20px">No invoices</td></tr>'}</tbody>
    <tfoot><tr>
      <td colspan="6" class="r">TOTALS</td>
      <td class="r">${L(totLitres)}</td>
      <td></td>
      <td class="r">${K(totAmount)}</td>
      <td></td>
    </tr></tfoot>
  </table>
<script>window.onafterprint = function(){ window.close(); };</script>
</body></html>`;
  openPrint(html);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
