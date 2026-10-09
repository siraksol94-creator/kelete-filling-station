// System Backups page — Ref 11 of the ZRA Self-Declaration.
//
// Lists snapshots produced by the nightly cron under /var/backups/kelete,
// lets an admin trigger a manual backup, and provides a per-snapshot
// download link. Auditor-friendly: everything on one page.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiDownload, FiDatabase, FiPlay, FiCheckCircle, FiAlertTriangle } from 'react-icons/fi';
import { getSystemBackups, createSystemBackup, downloadSystemBackup } from '../services/api';

const Backups = () => {
  const [rows, setRows]         = useState([]);
  const [root, setRoot]         = useState('');
  const [note, setNote]         = useState('');
  const [loading, setLoading]   = useState(true);
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState(null); // name being downloaded, or null
  const [message, setMessage]   = useState(null); // { type:'ok'|'err', text }

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await getSystemBackups();
      setRows(data.backups || []);
      setRoot(data.root || '');
      setNote(data.note || '');
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const runDownload = async (name) => {
    setDownloading(name); setMessage(null);
    try {
      await downloadSystemBackup(name);
      setMessage({ type: 'ok', text: `Downloaded ${name}` });
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message || 'Download failed' });
    }
    setDownloading(null);
  };

  const runBackup = async () => {
    if (!window.confirm('Create a manual backup snapshot now?')) return;
    setCreating(true); setMessage(null);
    try {
      const { data } = await createSystemBackup();
      setMessage({
        type: 'ok',
        text: data.method === 'script'
          ? 'Backup script completed.'
          : `Inline backup completed — ${data.files_copied} database file(s) copied to ${data.dest}.`,
      });
      load();
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
    setCreating(false);
  };

  const totalBytes = rows.reduce((s, r) => s + (r.size_bytes || 0), 0);
  const totalHuman = totalBytes < 1024 * 1024
    ? `${(totalBytes / 1024).toFixed(1)} KB`
    : totalBytes < 1024 * 1024 * 1024
      ? `${(totalBytes / 1024 / 1024).toFixed(1)} MB`
      : `${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`;

  return (
    <div style={{ padding: 24, background: '#f8fafc', height: '100vh', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>System Backups</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Automated nightly snapshots of every branch database. Kept 14 days on the server. Download any snapshot as a .tar.gz.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={load} disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 16px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <FiRefreshCw size={14} /> Refresh
          </button>
          <button onClick={runBackup} disabled={creating}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 8, border: 'none', background: creating ? '#9ca3af' : '#16a34a', color: '#fff', cursor: creating ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700 }}>
            <FiPlay size={14} /> {creating ? 'Creating…' : 'Create Backup Now'}
          </button>
        </div>
      </div>

      {message && (
        <div style={{
          padding: '12px 16px', marginBottom: 16, borderRadius: 8, fontSize: 13,
          background: message.type === 'ok' ? '#f0fdf4' : '#fef2f2',
          color:      message.type === 'ok' ? '#166534' : '#b91c1c',
          border:     `1px solid ${message.type === 'ok' ? '#86efac' : '#fecaca'}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {message.type === 'ok' ? <FiCheckCircle size={16} /> : <FiAlertTriangle size={16} />}
          {message.text}
        </div>
      )}

      {/* Summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 20 }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Backup Folder</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', fontFamily: 'monospace', wordBreak: 'break-all' }}>{root || '—'}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Snapshots</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#111827' }}>{rows.length}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Storage Used</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#111827' }}>{totalHuman}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Schedule</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Daily @ 02:00 CAT</div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>14-day retention</div>
        </div>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 22 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: '#111827' }}>Snapshots</h3>
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            {note ? note : 'No backups on disk yet. Click "Create Backup Now" to make the first one.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Snapshot</th>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Created</th>
                  <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Databases</th>
                  <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Size</th>
                  <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.name} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '10px 12px', color: '#111827', fontFamily: 'monospace', fontWeight: 700 }}>
                      <FiDatabase size={12} style={{ marginRight: 6, verticalAlign: 'middle', color: '#6366f1' }} />
                      {r.name}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#6b7280' }}>{(r.created_at || '').replace('T', ' ').slice(0, 19)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>{r.db_count}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>{r.size_human}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <button
                        onClick={() => runDownload(r.name)}
                        disabled={downloading === r.name}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 6, border: '1.5px solid #2563eb', background: downloading === r.name ? '#f3f4f6' : '#fff', color: downloading === r.name ? '#9ca3af' : '#2563eb', cursor: downloading === r.name ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700 }}>
                        <FiDownload size={12} /> {downloading === r.name ? 'Downloading…' : 'Download'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default Backups;
