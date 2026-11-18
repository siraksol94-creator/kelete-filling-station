// MirrorResultModal — the "Sync complete" summary after Sync Products to All.
// 2026-09-13 — moved out of pages/HqOverview.js unchanged when the button
// moved to Item Details, so either page can show it.
import React from 'react';
import { FiX, FiCheckCircle } from 'react-icons/fi';

export default function MirrorResultModal({ result, onClose }) {
  const { entities = {}, per_branch = {}, elapsed_ms = 0 } = result || {};
  const slugs = Object.keys(per_branch);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(720px, 92vw)', maxHeight: '85vh', overflow: 'auto' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FiCheckCircle color="#16a34a" />
            <h3 style={{ margin: 0, fontSize: 16, color: '#0f172a' }}>Sync complete</h3>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}><FiX size={20} /></button>
        </div>

        <div style={{ padding: 18 }}>
          <p style={{ margin: '0 0 12px 0', fontSize: 13, color: '#475569' }}>
            Pushed <strong>{entities.products || 0}</strong> products, <strong>{entities.categories || 0}</strong> categories, <strong>{entities.main_categories || 0}</strong> main categories, <strong>{entities.units || 0}</strong> units to <strong>{slugs.length}</strong> branch(es) in {elapsed_ms} ms.
          </p>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                  <th style={th}>Branch</th>
                  <th style={th}>Products</th>
                  <th style={th}>Categories</th>
                  <th style={th}>Units</th>
                  <th style={th}>Errors</th>
                </tr>
              </thead>
              <tbody>
                {slugs.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 14, textAlign: 'center', color: '#94a3b8' }}>No registered branches.</td></tr>
                )}
                {slugs.map(slug => {
                  const b = per_branch[slug] || {};
                  const errCount = ['products','categories','units','main_categories']
                    .reduce((a, k) => a + ((b[k]?.errors?.length) || 0), 0);
                  return (
                    <tr key={slug} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={td}><strong>{slug}</strong></td>
                      <td style={td}>{cellCount(b.products)}</td>
                      <td style={td}>{cellCount(b.categories)}</td>
                      <td style={td}>{cellCount(b.units)}</td>
                      <td style={{ ...td, color: errCount > 0 ? '#b91c1c' : '#16a34a', fontWeight: 600 }}>{errCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={{ marginTop: 14, fontSize: 11, color: '#94a3b8' }}>
            Inserted = new rows added at the branch. Updated = HQ-owned fields (name, code, category, units, image, barcode) refreshed; branch prices, stock, status are untouched.
          </p>
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid #e5e7eb', textAlign: 'right' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 };
const td = { padding: '8px 10px', color: '#0f172a' };
const cellCount = (b) => b
  ? `${b.pushed} new · ${b.updated} updated`
  : '—';
