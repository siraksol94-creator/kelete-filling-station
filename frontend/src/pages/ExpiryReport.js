import React, { useState, useEffect } from 'react';
import api from '../services/api';
import ExportButtons from '../components/ExportButtons';
import { useLanguage } from '../context/LanguageContext';
import { FiAlertTriangle, FiCheckCircle, FiClock, FiSearch } from 'react-icons/fi';
import { matchTokens } from '../utils/tokenSearch';

function daysBadge(days) {
  if (days === null || days === undefined) return null;
  if (days < 0)   return { label: `Expired ${Math.abs(days)}d ago`, bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' };
  if (days <= 7)  return { label: `${days}d left`,                  bg: '#fef9c3', color: '#854d0e', border: '#fcd34d' };
  if (days <= 30) return { label: `${days}d left`,                  bg: '#ffedd5', color: '#9a3412', border: '#fdba74' };
  return           { label: `${days}d left`,                         bg: '#dcfce7', color: '#166534', border: '#86efac' };
}

export default function ExpiryReport() {
  const { t } = useLanguage();
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [filter, setFilter]   = useState('all'); // all | expired | soon | ok

  useEffect(() => {
    api.get('/grn/expiry-report')
      .then(r => setRows(r.data))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = rows.filter(r => {
    const matchSearch = matchTokens(search, r.product_name, r.grn_number, r.product_code);
    const d = r.days_remaining;
    const matchFilter =
      filter === 'all'     ? true :
      filter === 'expired' ? d < 0 :
      filter === 'soon'    ? d >= 0 && d <= 30 :
      filter === 'ok'      ? d > 30 :
      true;
    return matchSearch && matchFilter;
  });

  const counts = {
    expired: rows.filter(r => r.days_remaining < 0).length,
    soon:    rows.filter(r => r.days_remaining >= 0 && r.days_remaining <= 30).length,
    ok:      rows.filter(r => r.days_remaining > 30).length,
  };

  return (
    <div className="page-content">
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>{t('expiryReport')}</h1>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>GRN items with recorded expiry dates</p>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <FiAlertTriangle size={18} color="#dc2626" />
            <span style={{ fontWeight: 700, color: '#991b1b', fontSize: 14 }}>Expired</span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#991b1b' }}>{counts.expired}</div>
        </div>
        <div style={{ background: '#fef9c3', border: '1px solid #fcd34d', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <FiClock size={18} color="#d97706" />
            <span style={{ fontWeight: 700, color: '#854d0e', fontSize: 14 }}>Expiring ≤30 days</span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#854d0e' }}>{counts.soon}</div>
        </div>
        <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <FiCheckCircle size={18} color="#16a34a" />
            <span style={{ fontWeight: 700, color: '#166534', fontSize: 14 }}>Good (&gt;30 days)</span>
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#166534' }}>{counts.ok}</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <FiSearch style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} size={15} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('searchProductOrGRN')}
            style={{ width: '100%', paddingLeft: 32, padding: '9px 12px 9px 32px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}
          />
        </div>
        {['all', 'expired', 'soon', 'ok'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
              background: filter === f ? '#111827' : '#f3f4f6',
              color:      filter === f ? '#fff'     : '#374151',
              border:     filter === f ? '1px solid #111827' : '1px solid #e5e7eb',
            }}
          >
            {f === 'all' ? 'All' : f === 'expired' ? 'Expired' : f === 'soon' ? '≤30 days' : '>30 days'}
          </button>
        ))}
        {/* v1.13.43 — universal export (ZRA #30) */}
        <ExportButtons
          rows={filtered}
          filename="expiry-report"
          sheetName="Expiry"
          columns={[
            { key: 'product_name',   label: 'Product' },
            { key: 'grn_number',     label: 'GRN #' },
            { key: 'grn_date',       label: 'Date Received' },
            { key: 'quantity',       label: 'Qty', format: v => Number(v || 0) },
            { key: 'unit_cost',      label: 'Unit Cost', format: v => Number(v || 0).toFixed(2) },
            { key: 'expiry_date',    label: 'Expiry Date' },
            { key: 'days_remaining', label: 'Days Left' },
          ]}
          pdfOptions={{ title: 'Expiry Report' }}
        />
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>No items found.</div>
        ) : (
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb', position: 'sticky', top: 0, zIndex: 1 }}>
                {[t('product'), t('grnNumber'), t('dateReceived'), t('quantity'), t('unitCost'), t('expiryDate'), t('status')].map((h, i) => (
                  <th key={i} style={{ padding: '10px 14px', textAlign: i === 0 || i === 1 || i === 2 || i === 5 || i === 6 ? 'left' : 'right', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, idx) => {
                const badge = daysBadge(row.days_remaining);
                return (
                  <tr key={idx} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827', fontSize: 13 }}>{row.product_name}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280', fontSize: 12, fontFamily: 'monospace' }}>{row.grn_number}</td>
                    <td style={{ padding: '10px 14px', color: '#374151', fontSize: 12 }}>{row.grn_date}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#374151', fontSize: 13 }}>{parseFloat(row.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })} {row.unit}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#374151', fontSize: 13 }}>{parseFloat(row.unit_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    <td style={{ padding: '10px 14px', color: '#374151', fontSize: 12 }}>{row.expiry_date}</td>
                    <td style={{ padding: '10px 14px' }}>
                      {badge && (
                        <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 12, fontSize: 11.5, fontWeight: 600, background: badge.bg, color: badge.color, border: `1px solid ${badge.border}` }}>
                          {badge.label}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
