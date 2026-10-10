// Receipt-style print helpers used by both Credit Sales and 1Card Sales
// pages. Opens a new window with the formatted HTML and triggers print.
// Kept separate so a missed print can be re-triggered from the row's
// Print button and so the list page can print the whole filtered list.

const K = n => 'K ' + Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const L = n => Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function openPrint(html) {
  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) { alert('Pop-ups blocked. Allow pop-ups to print.'); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); }, 250);
}

function brand() {
  // Deliberately tenant-agnostic header; branch slug comes from the URL
  const slug = (window.location.hostname.split('.')[0] || '').toUpperCase();
  return { name: 'KELETE FILLING STATION', branch: slug };
}

export function printTicket(t, method) {
  const b = brand();
  const isCard = method === '1Card';
  const title = isCard ? 'ENGEN 1CARD TICKET' : 'CREDIT SALE TICKET';
  const dateStr = (t.date || (t.created_at || '').slice(0, 10)) + ' ' + ((t.created_at || '').slice(11, 19) || '');
  const html = `
<!doctype html><html><head><meta charset="utf-8"><title>${title} #${t.id || ''}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font-family: 'Courier New', monospace; font-size: 12px; margin: 0; padding: 6px; color: #000; }
  h1 { font-size: 14px; text-align: center; margin: 2px 0; }
  .sub { text-align: center; font-size: 11px; margin-bottom: 6px; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; font-size: 12px; vertical-align: top; }
  td.r { text-align: right; }
  .big { font-size: 15px; font-weight: 700; }
  .center { text-align: center; }
  .foot { margin-top: 10px; font-size: 10px; text-align: center; }
  .sig { margin-top: 24px; }
  .sigline { border-top: 1px solid #000; width: 60%; margin: 2px auto 0; }
</style></head><body>
  <h1>${b.name}</h1>
  <div class="sub">${b.branch}<br>${title}</div>
  <hr>
  <table>
    <tr><td>Ticket #</td><td class="r">${t.id || '—'}</td></tr>
    <tr><td>Date</td><td class="r">${dateStr}</td></tr>
    <tr><td>Attendant</td><td class="r">${esc(t.attendant_name || '—')}</td></tr>
    <tr><td>Shift</td><td class="r">#${t.shift_id || '—'}</td></tr>
    <tr><td>Receipt #</td><td class="r">${esc(t.receipt_number || '—')}</td></tr>
  </table>
  <hr>
  <table>
    <tr><td>${isCard ? 'Card Holder' : 'Customer'}</td><td class="r"><strong>${esc(t.customer_name || '')}</strong></td></tr>
    ${isCard ? `<tr><td>Card #</td><td class="r">${esc(t.card_number || '—')}</td></tr>` : ''}
    <tr><td>Vehicle</td><td class="r">${esc(t.vehicle_registration || '—')}</td></tr>
  </table>
  <hr>
  <table>
    <tr><td>Grade</td><td class="r">${esc(t.grade_name || '—')}</td></tr>
    <tr><td>Litres</td><td class="r">${L(t.litres)} L</td></tr>
    <tr><td>Price/L</td><td class="r">${K(t.price_per_litre)}</td></tr>
    <tr><td class="big">TOTAL</td><td class="r big">${K(t.amount)}</td></tr>
  </table>
  <hr>
  <div class="center">${isCard ? 'Signature not required — card holder' : 'Signed below acknowledges receipt of fuel on credit'}</div>
  ${!isCard ? '<div class="sig"><div class="sigline"></div><div class="center">Customer signature</div></div>' : ''}
  <div class="sig"><div class="sigline"></div><div class="center">Attendant signature</div></div>
  <div class="foot">Printed ${new Date().toLocaleString()}</div>
<script>window.onafterprint = function(){ window.close(); };</script>
</body></html>`;
  openPrint(html);
}

export function printTicketList(rows, method, filter) {
  const b = brand();
  const isCard = method === '1Card';
  const title = isCard ? 'Engen 1Card Sales — List' : 'Credit Sales — List';
  const totLitres = rows.reduce((s, r) => s + Number(r.litres || 0), 0);
  const totAmount = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const rowsHtml = rows.map(r => `
    <tr>
      <td>${(r.date || (r.created_at || '').slice(0, 10)) || ''}</td>
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
  h1 { font-size: 16px; margin: 0 0 2px; }
  .sub { font-size: 11px; color: #333; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 5px 6px; font-size: 11px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; }
  td.r, th.r { text-align: right; }
  tfoot td { font-weight: 700; background: #f9fafb; }
  .meta { margin-bottom: 10px; font-size: 11px; }
</style></head><body>
  <h1>${b.name} — ${b.branch}</h1>
  <div class="sub">${title}</div>
  <div class="meta">
    Range: <strong>${esc(filter?.from || '')}</strong> → <strong>${esc(filter?.to || '')}</strong>
    &nbsp;·&nbsp; Rows: <strong>${rows.length}</strong>
    &nbsp;·&nbsp; Printed: ${new Date().toLocaleString()}
  </div>
  <table>
    <thead><tr>
      <th>Date</th><th>Attendant</th><th>${isCard ? 'Card Holder · #' : 'Customer'}</th>
      <th>Vehicle</th><th>Grade</th>
      <th class="r">Litres</th><th class="r">K/L</th><th class="r">Amount</th><th>Receipt #</th>
    </tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="9" style="text-align:center;color:#999;padding:20px">No tickets</td></tr>'}</tbody>
    <tfoot><tr>
      <td colspan="5" class="r">TOTALS</td>
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
