// exportReport — one place that turns a report's rows + columns spec
// into an Excel workbook, a CSV file or a print-ready PDF. Wired
// everywhere via <ExportButtons/> to satisfy ZRA checklist item 30
// ("every report exportable to Excel / CSV / PDF / MS-Access").
//
// A column spec is `{ key, label, format? }` where:
//   - key    picks the field on the row object
//   - label  is what appears in the header (defaults to key)
//   - format is an optional (val, row) => string transformer

import * as XLSX from 'xlsx';
import html2pdf from 'html2pdf.js';

// ── Common helpers ──────────────────────────────────────────────────
const safeName = (s) => String(s || 'report')
  .replace(/[^a-z0-9._-]+/gi, '_')
  .replace(/_+/g, '_')
  .slice(0, 80);

const stamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
};

// Turn a row + column spec into `[val1, val2, …]`, applying format() when
// present. Nullish values become '' so downstream renderers don't emit
// "undefined" or "null" literals.
const renderRow = (row, columns) =>
  columns.map(c => {
    const raw = row?.[c.key];
    if (typeof c.format === 'function') {
      const out = c.format(raw, row);
      return out == null ? '' : out;
    }
    return raw == null ? '' : raw;
  });

const headerLabels = (columns) => columns.map(c => c.label || c.key);

// ── CSV ─────────────────────────────────────────────────────────────
export function exportRowsToCsv(rows, columns, filename) {
  const escapeCell = (v) => {
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [];
  lines.push(headerLabels(columns).map(escapeCell).join(','));
  for (const row of rows) {
    lines.push(renderRow(row, columns).map(escapeCell).join(','));
  }
  // \r\n keeps Excel happy on Windows.
  const csv = lines.join('\r\n');
  // BOM so Excel reads UTF-8 accented text correctly.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, `${safeName(filename)}_${stamp()}.csv`);
}

// ── Excel (.xlsx) ───────────────────────────────────────────────────
export function exportRowsToXlsx(rows, columns, filename, sheetName = 'Report') {
  const aoa = [headerLabels(columns), ...rows.map(r => renderRow(r, columns))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Best-effort column widths — 10 chars per column min, capped at 40.
  ws['!cols'] = columns.map(c => {
    const label = c.label || c.key || '';
    const sample = rows.slice(0, 20).map(r => {
      const rendered = renderRow(r, [c])[0];
      return String(rendered ?? '').length;
    });
    const widest = Math.max(label.length, ...sample, 8);
    return { wch: Math.min(widest + 2, 40) };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 30));
  XLSX.writeFile(wb, `${safeName(filename)}_${stamp()}.xlsx`);
}

// ── PDF ─────────────────────────────────────────────────────────────
// Builds a printable HTML table and hands it to html2pdf. Landscape by
// default so wider reports don't wrap. Falls back to portrait for
// narrow (≤5 cols) reports.
export function exportRowsToPdf(rows, columns, filename, opts = {}) {
  const {
    title       = filename || 'Report',
    subtitle    = '',
    businessName = '',
    orientation = columns.length > 5 ? 'landscape' : 'portrait',
  } = opts;

  const th = columns.map(c => `<th>${escapeHtml(c.label || c.key)}</th>`).join('');
  const body = rows.map(row => {
    const cells = renderRow(row, columns)
      .map(v => `<td>${escapeHtml(v)}</td>`)
      .join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; padding: 16px; color: #111;">
      ${businessName ? `<div style="font-size:14px;font-weight:800;letter-spacing:0.5px;">${escapeHtml(businessName)}</div>` : ''}
      <div style="font-size:16px;font-weight:800;margin-top:4px;">${escapeHtml(title)}</div>
      ${subtitle ? `<div style="font-size:11px;color:#555;">${escapeHtml(subtitle)}</div>` : ''}
      <div style="font-size:10px;color:#888;margin-bottom:10px;">Generated ${new Date().toLocaleString()}</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="background:#f2f4f7;">${th}</tr>
        </thead>
        <tbody>${body || `<tr><td colspan="${columns.length}" style="text-align:center;color:#888;padding:12px;">No rows.</td></tr>`}</tbody>
      </table>
    </div>
  `;

  const container = document.createElement('div');
  container.innerHTML = html;
  // Push it off-screen — html2pdf still measures from a mounted node.
  container.style.position = 'fixed';
  container.style.left     = '-10000px';
  container.style.top      = '0';
  document.body.appendChild(container);

  // Style the table once it's in the DOM (avoids inline-style repetition
  // across every <td>).
  const table = container.querySelector('table');
  if (table) {
    table.querySelectorAll('th, td').forEach(cell => {
      cell.style.border = '1px solid #d0d5dd';
      cell.style.padding = '4px 6px';
      cell.style.textAlign = 'left';
      cell.style.verticalAlign = 'top';
    });
  }

  return html2pdf()
    .from(container)
    .set({
      margin:   [6, 6, 6, 6],
      filename: `${safeName(filename)}_${stamp()}.pdf`,
      image:    { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF:    { unit: 'mm', format: 'a4', orientation },
      pagebreak: { mode: ['css', 'legacy'] },
    })
    .save()
    .finally(() => document.body.removeChild(container));
}

// ── Utilities ───────────────────────────────────────────────────────
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
