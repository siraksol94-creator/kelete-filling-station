// ExportButtons — three-button strip (Excel / CSV / PDF) that any report
// page can drop next to its header. Satisfies ZRA checklist #30
// ("every report exportable"). See utils/exportReport for the actual
// serialisers.
//
// Usage:
//   <ExportButtons
//     filename="sales-report"
//     rows={filteredRows}
//     columns={[
//       { key: 'order_number',  label: 'Receipt #' },
//       { key: 'created_at',    label: 'Date',   format: v => new Date(v).toLocaleString() },
//       { key: 'total_amount',  label: 'Total',  format: v => `K${Number(v).toFixed(2)}` },
//     ]}
//     pdfOptions={{ title: 'Sales Report', subtitle: '2026-07-18', businessName }}
//   />
//
// Renders nothing when rows is empty AND `alwaysShow` is falsy.

import React, { useState } from 'react';
import { FiDownload, FiFileText } from 'react-icons/fi';
import { exportRowsToCsv, exportRowsToXlsx, exportRowsToPdf } from '../utils/exportReport';

const btnStyle = (color, disabled) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '7px 12px',
  borderRadius: 6,
  border: `1.5px solid ${color}`,
  background: disabled ? '#f3f4f6' : '#fff',
  color: disabled ? '#9ca3af' : color,
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: 12,
  fontWeight: 700,
  whiteSpace: 'nowrap',
});

export default function ExportButtons({
  rows = [],
  columns = [],
  filename = 'report',
  pdfOptions = {},
  sheetName = 'Report',
  alwaysShow = false,
  compact = false,
  // v1.13.116 — allow a report page to hide the PDF button when it
  // already renders a richer custom PDF via its own Export PDF button
  // (e.g. Sales Report has handleExportPDF + this trio). Default true
  // preserves behavior for every other report using this component.
  showPdf = true,
}) {
  const [busy, setBusy] = useState(null);
  if (!alwaysShow && rows.length === 0) return null;
  if (columns.length === 0) return null;

  const disabled = rows.length === 0;

  const run = async (kind, fn) => {
    if (disabled) return;
    setBusy(kind);
    try { await fn(); }
    catch (e) { console.error(`[export:${kind}]`, e); }
    setBusy(null);
  };

  return (
    <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={() => run('xlsx', () => exportRowsToXlsx(rows, columns, filename, sheetName))}
        disabled={disabled || busy}
        title={disabled ? 'No rows to export' : 'Download as Excel (.xlsx)'}
        style={btnStyle('#16a34a', disabled)}>
        <FiDownload size={12} /> {busy === 'xlsx' ? '…' : (compact ? 'XLS' : 'Excel')}
      </button>
      <button
        type="button"
        onClick={() => run('csv', () => exportRowsToCsv(rows, columns, filename))}
        disabled={disabled || busy}
        title={disabled ? 'No rows to export' : 'Download as CSV'}
        style={btnStyle('#0369a1', disabled)}>
        <FiFileText size={12} /> {busy === 'csv' ? '…' : 'CSV'}
      </button>
      {showPdf && (
        <button
          type="button"
          onClick={() => run('pdf', () => exportRowsToPdf(rows, columns, filename, pdfOptions))}
          disabled={disabled || busy}
          title={disabled ? 'No rows to export' : 'Download as PDF'}
          style={btnStyle('#b91c1c', disabled)}>
          <FiFileText size={12} /> {busy === 'pdf' ? '…' : 'PDF'}
        </button>
      )}
    </div>
  );
}
